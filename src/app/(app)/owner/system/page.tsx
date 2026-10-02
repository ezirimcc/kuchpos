import type { Metadata } from "next";
import { headers } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/server/auth/request";
import { getSystemCheck } from "@/server/platform/system";

export const metadata: Metadata = { title: "System check — KuchPos" };

export default async function SystemCheckPage() {
  const context = await requirePagePermission("owner.manage");
  const requestHeaders = await headers();
  const check = await getSystemCheck(context, {
    forwardedFor: requestHeaders.get("x-forwarded-for"),
    forwardedProto: requestHeaders.get("x-forwarded-proto"),
  });

  const facts: [string, string][] = [
    ["App version", check.appVersion],
    ["Site", check.environment],
    ["Node.js", check.nodeVersion],
    ["Memory in use", `${check.memoryMegabytes} MB`],
    ["Database", check.databaseVersion],
    ["Database clock", check.databaseTimeZone === "+00:00" ? "Universal time (correct)" : check.databaseTimeZone],
    ["Your internet address, as the app sees it", check.visitorAddress ?? "Not reported by the server"],
    ["Your connection, as the app sees it", check.visitorConnection ?? "Not reported by the server"],
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System check</h1>
        <p className="text-sm text-muted-foreground">
          A report on the server this app is running on. Look at it after each upload of a new version.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>This server</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {facts.map(([label, value]) => (
                <TableRow key={label}>
                  <TableCell className="w-80 text-muted-foreground">{label}</TableCell>
                  <TableCell className="font-medium">{value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules the database enforces by itself</CardTitle>
          <CardDescription>
            Each rule was just tried for real against this database and then undone. Every line should say
            “Enforced”.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {check.rules.map((rule) => (
                <TableRow key={rule.name} data-testid="system-rule">
                  <TableCell>{rule.name}</TableCell>
                  <TableCell className="w-40">
                    {rule.enforced ? (
                      <Badge variant="success">Enforced</Badge>
                    ) : (
                      <Badge variant="destructive">NOT enforced</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
