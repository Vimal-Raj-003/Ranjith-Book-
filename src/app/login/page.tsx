import { Suspense } from "react";
import { redirect } from "next/navigation";
import SignIn from "@/components/SignIn";
import { currentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
