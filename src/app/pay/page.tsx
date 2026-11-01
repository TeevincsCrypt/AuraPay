import { Suspense } from "react";
import { PayFlow } from "@/components/pay/pay-flow";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Pay · AuraPay" };

export default function PayPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PayFlow />
    </Suspense>
  );
}
