"use client";

import * as React from "react";
import { catchError } from "~/utils";

import { Icons } from "~/islands/icons";
import { Button } from "~/islands/primitives/button";
import { createAccountLinkAction } from "~/utils/stripe/actions";

interface ConnectToStripeButtonProps {
  storeId: number;
}

export function ConnectStoreToStripeButton({
  storeId,
}: ConnectToStripeButtonProps) {
  const [isPending, startTransaction] = React.useTransition();

  return (
    <Button
      aria-label="Connect to Stripe"
      onClick={() => {
        startTransaction(async () => {
          try {
            const connection = await createAccountLinkAction({ storeId });
            window.location.href = connection.url;
          } catch (err) {
            catchError(err);
          }
        });
      }}
      disabled={isPending}
    >
      {isPending && (
        <Icons.spinner
          className="mr-2 h-4 w-4 animate-spin"
          aria-hidden="true"
        />
      )}
      Connect to Stripe
    </Button>
  );
}
