import Studio from "@/components/Studio";
import { currentUser } from "@/lib/auth/session";
import SignIn from "@/components/SignIn";
import { prisma } from "@/lib/db";
import { parseProvider, resolveProvider } from "@/lib/content/cli";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) return <SignIn />;

  const [providerRow, chosenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "cliProvider" } }),
    prisma.setting.findUnique({ where: { key: "engineChosen" } }),
  ]);
  const parsed = parseProvider(providerRow?.value);
  const chosen = chosenRow?.value === "1" && parsed !== null;
  const provider = parsed ?? resolveProvider(process.env.BOOKREEL_CLI_PROVIDER);

  return <Studio email={user.email} initialEngine={{ chosen, provider }} />;
}
