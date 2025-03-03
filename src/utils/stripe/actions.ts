"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clerkClient } from "@clerk/nextjs";
import { getNextAuthServerSession } from "~/auth";
import { env } from "~/env.mjs";
import type { UserSubscriptionPlan } from "~/types";
import { type CheckoutItem } from "~/types";
import { absoluteUrl, calculateOrderAmount, ERR } from "~/utils";
import dayjs from "dayjs";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { storeSubscriptionPlans } from "~/server/config/subscriptions";
import { db } from "~/data/db";
import { carts, payments, stores, User, users } from "~/data/db/schema";
import { userPrivateMetadataSchema } from "~/data/validations/auth";
import { stripe } from "~/utils/stripe/connect";
import {
  createPaymentIntentSchema,
  getPaymentIntentSchema,
  getPaymentIntentsSchema,
  getStripeAccountSchema,
  manageSubscriptionSchema,
} from "~/utils/stripe/zod";
import { getServerAuthSession, getUserData } from "~/utils/users";

// Getting the subscription plan for a user
export async function getSubscriptionPlanAction(
  userId: string,
): Promise<UserSubscriptionPlan | null> {
  try {
    let userPrivateMetadata: z.infer<typeof userPrivateMetadataSchema> = {};
    if (env.NEXT_PUBLIC_AUTH_PROVIDER === "clerk") {
      const session = await clerkClient.users.getUser(userId);
      if (!session) redirect("/auth");
      userPrivateMetadata = userPrivateMetadataSchema.parse(
        session.privateMetadata,
      );
    } else if (env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") {
      const session = await getNextAuthServerSession();
      if (!session) redirect("/auth");
      const user = await db
        .select()
        .from(users)
        .where(eq(users.id, session.user.id))
        .then((res: User[]) => res[0] ?? null);
      userPrivateMetadata = userPrivateMetadataSchema.parse(user);
    }

    // Check if user is subscribed
    const ONE_DAY_MS = 86_400_000;
    const isSubscribed =
      !!userPrivateMetadata.stripePriceId &&
      dayjs(userPrivateMetadata.stripeCurrentPeriodEnd).valueOf() + ONE_DAY_MS >
        Date.now();

    const plan = isSubscribed
      ? storeSubscriptionPlans.find(
          (plan) => plan.stripePriceId === userPrivateMetadata.stripePriceId,
        )
      : storeSubscriptionPlans[0]; // Set default to "Starter" subscription

    // Check if user has canceled subscription
    let isCanceled = false;
    if (isSubscribed && !!userPrivateMetadata.stripeSubscriptionId) {
      const stripePlan = await stripe.subscriptions.retrieve(
        userPrivateMetadata.stripeSubscriptionId,
      );
      isCanceled = stripePlan.cancel_at_period_end;
    }

    if (plan) {
      return {
        ...plan,
        isCanceled,
        isSubscribed,
        stripeCurrentPeriodEnd:
          userPrivateMetadata.stripeCurrentPeriodEnd ?? "",
        stripeSubscriptionId: userPrivateMetadata.stripeSubscriptionId,
        stripeCustomerId: userPrivateMetadata.stripeCustomerId,
        isActive: isSubscribed && !isCanceled,
      };
    } else {
      console.error("Plan not found");
      return null;
    }
  } catch (err) {
    console.error(err);
    return null;
  }
}

// Managing stripe subscriptions for a user
export async function manageSubscriptionAction(
  rawInput: z.infer<typeof manageSubscriptionSchema>,
) {
  const input = manageSubscriptionSchema.parse(rawInput);

  const billingUrl = absoluteUrl("/dashboard/billing");

  const user = await getServerAuthSession();
  if (!user) redirect("/auth");

  const data = await getUserData(user);
  const email = data.email;

  // If the user is already subscribed to a plan, we redirect them to the Stripe billing portal
  if (input.isSubscribed && input.stripeCustomerId && input.isCurrentPlan) {
    const stripeSession = await stripe.billingPortal.sessions.create({
      customer: input.stripeCustomerId,
      return_url: billingUrl,
    });

    return {
      url: stripeSession.url,
    };
  }

  // If the user is not subscribed to a plan, we create a Stripe Checkout session
  const stripeSession = await stripe.checkout.sessions.create({
    success_url: billingUrl,
    cancel_url: billingUrl,
    payment_method_types: ["card"],
    mode: "subscription",
    billing_address_collection: "auto",
    customer_email: email,
    line_items: [
      {
        price: input.stripePriceId,
        quantity: 1,
      },
    ],
    metadata: {
      userId: user.id,
    },
  });

  return {
    url: stripeSession.url,
  };
}

// Getting the Stripe account for a store
export async function getStripeAccountAction(
  input: z.infer<typeof getStripeAccountSchema>,
) {
  const retrieveAccount = input.retrieveAccount ?? true;

  const falsyReturn = {
    isConnected: false,
    account: null,
    payment: null,
  };

  try {
    const store = await db.query.stores.findFirst({
      columns: {
        stripeAccountId: true,
      },
      where: eq(stores.id, input.storeId),
    });

    if (!store) return falsyReturn;

    const payment = await db.query.payments.findFirst({
      columns: {
        stripeAccountId: true,
        detailsSubmitted: true,
      },
      where: eq(payments.storeId, input.storeId),
    });

    if (!payment || !payment.stripeAccountId) return falsyReturn;

    if (!retrieveAccount)
      return {
        isConnected: true,
        account: null,
        payment,
      };

    const account = await stripe.accounts.retrieve(payment.stripeAccountId);

    if (!account) return falsyReturn;

    // If the account details have been submitted, we update the store and payment records
    if (account.details_submitted && !payment.detailsSubmitted) {
      await db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({
            detailsSubmitted: account.details_submitted,
            stripeAccountCreatedAt: account.created,
          })
          .where(eq(payments.storeId, input.storeId));

        await tx
          .update(stores)
          .set({
            stripeAccountId: account.id,
            active: true,
          })
          .where(eq(stores.id, input.storeId));
      });
    }

    return {
      isConnected: payment.detailsSubmitted,
      account: account.details_submitted ? account : null,
      payment,
    };
  } catch (err) {
    err instanceof Error && console.error(err.message);
    return falsyReturn;
  }
}

// Connecting a Stripe account to a store
export async function createAccountLinkAction(
  input: z.infer<typeof getStripeAccountSchema>,
) {
  const { isConnected, payment, account } = await getStripeAccountAction(input);

  if (isConnected) {
    throw new Error("Store already connected to Stripe.");
  }

  // Delete the existing account if details have not been submitted
  if (account && !account.details_submitted) {
    await stripe.accounts.del(account.id);
  }

  const stripeAccountId =
    payment?.stripeAccountId ?? (await createStripeAccount());

  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: absoluteUrl(`/dashboard/stores/${input.storeId}`),
    return_url: absoluteUrl(`/dashboard/stores/${input.storeId}`),
    type: "account_onboarding",
  });

  if (!accountLink?.url) {
    throw new Error("Error creating Stripe account link, please try again.");
  }

  return { url: accountLink.url };

  async function createStripeAccount(): Promise<string> {
    const account = await stripe.accounts.create({ type: "standard" });

    if (!account) {
      throw new Error("Error creating Stripe account.");
    }

    // If payment record exists, we update it with the new account id
    if (payment) {
      await db.update(payments).set({
        stripeAccountId: account.id,
      });
    } else {
      await db.insert(payments).values({
        storeId: input.storeId,
        stripeAccountId: account.id,
      });
    }

    return account.id;
  }
}

// Creating checkout session for a store
export async function createCheckoutSessionAction(
  input: z.infer<typeof createPaymentIntentSchema>,
) {
  const { isConnected, payment } = await getStripeAccountAction(input);

  if (!isConnected || !payment) {
    throw new Error("Store not connected to Stripe.");
  }

  if (!payment.stripeAccountId) {
    throw new Error("Stripe account not found.");
  }

  const cartId = Number(cookies().get("cartId")?.value);

  const checkoutItems: CheckoutItem[] = input.items.map((item) => ({
    productId: item.id,
    price: Number(item.price),
    quantity: item.quantity,
    subcategory: item.subcategory,
  }));

  // Create a checkout session
  const checkoutSession = await stripe.checkout.sessions.create(
    {
      success_url: absoluteUrl(`/checkout/success/?store_id=${input.storeId}`),
      cancel_url: absoluteUrl("/checkout"),
      payment_method_types: ["card"],
      mode: "payment",
      line_items: input.items.map((item) => ({
        price_data: {
          currency: "usd",
          product_data: {
            name: item.name,
          },
          unit_amount: Number(item.price) * 100,
        },
        quantity: item.quantity,
      })),
      metadata: {
        cartId,
        items: JSON.stringify(checkoutItems),
      },
    },
    {
      stripeAccount: payment.stripeAccountId,
    },
  );

  // Update the cart with the checkout session id
  await db
    .update(carts)
    .set({
      checkoutSessionId: checkoutSession.id,
      paymentIntentId: String(checkoutSession.payment_intent),
    })
    .where(eq(carts.id, cartId));

  return {
    id: checkoutSession.id,
    url: checkoutSession.url ?? "/checkout",
  };
}

// Creating a payment intent for a store
export async function createPaymentIntentAction(
  input: z.infer<typeof createPaymentIntentSchema>,
): Promise<{ clientSecret: string | null }> {
  try {
    const { isConnected, payment } = await getStripeAccountAction(input);

    if (!isConnected || !payment) {
      throw new Error("Store not connected to Stripe.");
    }

    if (!payment.stripeAccountId) {
      throw new Error("Stripe account not found.");
    }

    const cartId = Number(cookies().get("cartId")?.value);

    const checkoutItems: CheckoutItem[] = input.items.map((item) => ({
      productId: item.id,
      price: Number(item.price),
      quantity: item.quantity,
      subcategory: item.subcategory,
    }));

    const metadata = {
      cartId: isNaN(cartId) ? "" : cartId,
      items: JSON.stringify(checkoutItems),
    };

    const { total, fee } = calculateOrderAmount(input.items);

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: total,
        application_fee_amount: fee,
        metadata,
        currency: "usd",
        automatic_payment_methods: {
          enabled: true,
        },
      },
      {
        stripeAccount: payment.stripeAccountId,
      },
    );

    await db
      .update(carts)
      .set({
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
      })
      .where(eq(carts.id, cartId));

    return {
      clientSecret: paymentIntent.client_secret,
    };
  } catch (err) {
    console.error(err);
    return {
      clientSecret: null,
    };
  }
}

// Getting payment intents for a store
export async function getPaymentIntentsAction(
  input: z.infer<typeof getPaymentIntentsSchema>,
) {
  try {
    const { isConnected, payment } = await getStripeAccountAction({
      storeId: input.storeId,
      retrieveAccount: false,
    });

    if (!isConnected || !payment) {
      throw new Error("Store not connected to Stripe.");
    }

    if (!payment.stripeAccountId) {
      throw new Error("Stripe account not found.");
    }

    const paymentIntents = await stripe.paymentIntents.list({
      limit: input.limit ?? 10,
      ...input,
    });

    return {
      paymentIntents: paymentIntents.data.map((item) => ({
        id: item.id,
        amount: item.amount,
        created: item.created,
        cartId: Number(item.metadata.cartId),
      })),
      hasMore: paymentIntents.has_more,
    };
  } catch (err) {
    console.error(err);
    return {
      paymentIntents: [],
      hasMore: false,
    };
  }
}

// Getting a payment intent for a store
export async function getPaymentIntentAction(
  input: z.infer<typeof getPaymentIntentSchema>,
) {
  try {
    const cartId = cookies().get("cartId")?.value;

    const { isConnected, payment } = await getStripeAccountAction({
      storeId: input.storeId,
      retrieveAccount: false,
    });

    if (!isConnected || !payment) {
      throw new Error("Store not connected to Stripe.");
    }

    if (!payment.stripeAccountId) {
      throw new Error("Stripe account not found.");
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(
      input.paymentIntentId,
      {
        stripeAccount: payment.stripeAccountId,
      },
    );

    if (paymentIntent.status !== "succeeded") {
      throw new Error("Payment intent not succeeded.");
    }

    if (
      paymentIntent.metadata.cartId !== cartId &&
      paymentIntent.shipping?.address?.postal_code?.split(" ").join("") !==
        input.deliveryPostalCode
    ) {
      throw new Error("CartId or delivery postal code does not match.");
    }

    return {
      paymentIntent,
      isVerified: true,
    };
  } catch (err) {
    console.error(err);
    return {
      paymentIntent: null,
      isVerified: false,
    };
  }
}

/**
 * Learning Resources and Inspirations:
 * ------------------------------------
 * @see https://github.com/steven-tey/dub/blob/main/apps/web/lib/stripe
 * @see https://github.com/alissonsleal/brapi/blob/main/services/stripe
 * @see https://github.com/sadmann7/skateshop/blob/main/src/app/_actions/stripe.ts
 * @see https://github.com/sadmann7/skateshop/blob/main/src/app/api/webhooks/stripe/route.ts
 * @see https://github.com/jackblatch/OneStopShop/blob/main/server-actions/stripe/payment.ts
 */
