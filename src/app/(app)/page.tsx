import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePageContext } from "@/server/auth/request";
import { ROLE_LABELS } from "@/server/permissions";

export default async function HomePage() {
  const context = await requirePageContext();
  // An owner with no business open starts at the list of businesses.
  if (!context.business) redirect("/owner/businesses");

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome, {context.actor.name}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{context.business.name}</CardTitle>
          <CardDescription>
            You are signed in as {ROLE_LABELS[context.actor.role].toLowerCase()}
            {context.actor.role === "OWNER" ? ", with full admin rights in this business" : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Use the menu on the left. Items marked “coming soon” are part of your role and will be
          switched on as each part of KuchPos is built.
        </CardContent>
      </Card>
    </div>
  );
}
