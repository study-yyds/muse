import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 统一复选框：品牌色 accent-primary + 聚焦环 + 禁用态。
 * 直接透传 props（兼容 react-hook-form 的 register 展开）。
 */
function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-4 shrink-0 rounded border border-input bg-background accent-primary cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Checkbox }
