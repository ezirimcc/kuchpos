import { PeriodLinks, analysisPeriods, periodText } from "@/app/(app)/reports/report-parts";
import { BarList } from "@/components/charts";
import { nairaFromText } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { getHomeAnalysis } from "@/server/business/analysis";
import { ValidationError } from "@/server/errors";

/**
 * The analysis charts on the home page (C70): the top five products, categories and
 * customers by sales, for a period chosen above them. Admins and owners only — the
 * operation refuses anyone else, and the home page does not draw this for them.
 */
export async function HomeAnalysis({ context, from, to, picked }: { context: AppContext; from: string; to: string; picked: string }) {
  const periods = analysisPeriods();
  // Today, unless a period was chosen.
  const asked = from || to ? { from, to } : { from: periods[0].from, to: periods[0].to };
  let analysis: Awaited<ReturnType<typeof getHomeAnalysis>>;
  try {
    analysis = await getHomeAnalysis(context, asked);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    analysis = await getHomeAnalysis(context, { from: periods[0].from, to: periods[0].to });
  }
  const { period } = analysis;
  const charts = [
    { testId: "top-products", title: "Top 5 products by sales", rows: analysis.products, none: "No product was sold in this period." },
    { testId: "top-categories", title: "Top 5 categories by sales", rows: analysis.categories, none: "Nothing was sold in this period." },
    { testId: "top-customers", title: "Top 5 customers by sales", rows: analysis.customers, none: "No named customer bought in this period." },
  ];
  return (
    <section id="analysis" className="flex flex-col gap-3" data-testid="home-analysis">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          Best sellers <span className="font-normal text-muted-foreground">· {periodText({ ...period })}</span>
        </h2>
        <PeriodLinks path="/" period={period} periods={periods} anchor="analysis" picked={picked} />
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        {charts.map((chart) =>
          chart.rows.length === 0 ? (
            <div key={chart.testId} className="rounded-3xl bg-card p-5 dark:border dark:border-border" data-testid={chart.testId}>
              <p className="font-semibold">{chart.title}</p>
              <p className="mt-4 text-sm text-muted-foreground">{chart.none}</p>
            </div>
          ) : (
            <BarList key={chart.testId} testId={chart.testId} title={chart.title} points={chart.rows.map((row) => ({ label: row.label, value: row.amount, shown: nairaFromText(row.amount) }))} />
          ),
        )}
      </div>
      <p className="text-xs text-muted-foreground">Sales after discounts and returns; cancelled sales are left out. Sales to customers who were not named are not in the customers chart.</p>
    </section>
  );
}
