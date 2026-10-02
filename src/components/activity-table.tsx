import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

type Entry = { id: string; createdAt: Date; actorName: string; summary: string };

export function ActivityTable({ entries }: { entries: Entry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has been recorded yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-48">When</TableHead>
          <TableHead className="w-48">Who</TableHead>
          <TableHead>What happened</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
            <TableCell>{entry.actorName}</TableCell>
            <TableCell>{entry.summary}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
