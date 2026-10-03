import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const alertVariants = cva("rounded-2xl border px-4 py-2.5 text-sm", {
  variants: {
    variant: {
      default: "bg-muted/50 text-foreground",
      success: "border-green-600/30 bg-green-600/10 text-green-800 dark:text-green-300",
      destructive: "border-destructive/30 bg-destructive/10 text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
})

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="status" className={cn(alertVariants({ variant }), className)} {...props} />
}

export { Alert }
