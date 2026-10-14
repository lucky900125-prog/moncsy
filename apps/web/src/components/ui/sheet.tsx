import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

/** Bottom sheet on mobile, centered dialog on larger screens. */
export function SheetContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentProps<typeof Dialog.Content> & { title: string; description?: string }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="overlay fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
      <Dialog.Content
        className={cn(
          "sheet-content fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border bg-popover text-popover-foreground shadow-xl outline-none",
          "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border sm:hidden" />
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-2">
          <div>
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-0.5 text-sm text-muted-foreground">{description}</Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">{title}</Dialog.Description>
            )}
          </div>
          <Dialog.Close className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" />
            <span className="sr-only">Bezárás</span>
          </Dialog.Close>
        </div>
        <div className="overflow-y-auto px-5 pb-5 pb-safe">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
