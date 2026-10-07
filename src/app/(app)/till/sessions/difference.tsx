import { Badge } from "@/components/ui/badge";
import { nairaFromText } from "@/lib/format";

/** How the counted cash compared with the expected cash: balanced, short or over. */
export function Difference({ amount }: { amount: string }) {
  if (amount === "0.00") {
    return (
      <Badge variant="success" data-testid="till-difference">
        Balanced
      </Badge>
    );
  }
  const short = amount.startsWith("-");
  return (
    <Badge variant="destructive" data-testid="till-difference">
      {nairaFromText(amount.replace("-", ""))} {short ? "short" : "over"}
    </Badge>
  );
}
