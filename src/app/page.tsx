import Studio from "@/components/Studio";
import { currentUser } from "@/lib/auth/session";
import SignIn from "@/components/SignIn";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <SignIn />;
  return <Studio email={user.email} />;
}
