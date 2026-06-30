"use client";

import { Cpu, Info, Palette, UserRound, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";

import { AccountIdentity, AccountIdentityFallback } from "@/components/account-identity";
import { ClientOnly } from "@/components/client-only";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  EFFORT_OPTIONS,
  ENGINE_OPTIONS,
  MODEL_OPTIONS,
  type SelectOption,
} from "@/lib/chat-options";
import { type Preferences, THEME_OPTIONS } from "@/lib/preferences";
import { cn } from "@/lib/utils";

/** A titled settings group. */
function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3.5">
      <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide">
        <Icon className="size-3.5" />
        {title}
      </h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** A label (+ optional hint) on the left, a control on the right. */
function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-foreground block text-sm">
          {label}
        </label>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A DS Select bound to a preference. */
function PrefSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={ariaLabel} className="min-w-[8.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The settings + personalization sheet (BRO-1618): a right-anchored slide-over
 *  built on radix Dialog (focus-trap + Escape + scroll-lock). Account · Appearance
 *  · Models · About. Account ACTIONS (sign-out, passkey, danger zone) land in A2;
 *  Engine lands in B. */
export function SettingsSheet({
  open,
  onOpenChange,
  prefs,
  onUpdate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: Preferences;
  onUpdate: (partial: Partial<Preferences>) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.14_0.025_270/0.45)] duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-slot="settings-sheet"
          className={cn(
            "bg-background text-foreground border-border fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-xl outline-none sm:max-w-md",
            "duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          )}
        >
          <div className="border-border flex items-center justify-between border-b px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3">
            <DialogPrimitive.Title className="font-heading text-base font-medium tracking-tight">
              Settings
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close settings">
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">
            Configure appearance, model defaults, and your account.
          </DialogPrimitive.Description>

          <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <Section icon={UserRound} title="Account">
              <div className="flex items-center gap-3">
                <ClientOnly fallback={<AccountIdentityFallback />}>
                  <AccountIdentity />
                </ClientOnly>
              </div>
            </Section>

            <Section icon={Palette} title="Appearance">
              <Row label="Theme">
                <SegmentedControl
                  type="single"
                  value={prefs.theme}
                  onValueChange={(v) => v && onUpdate({ theme: v as Preferences["theme"] })}
                  aria-label="Theme"
                >
                  {THEME_OPTIONS.map((o) => (
                    <SegmentedControlItem key={o.value} value={o.value}>
                      {o.label}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </Row>
              <Row
                label="Show reasoning"
                hint="Display the model's summarized thinking panel above answers."
                htmlFor="pref-show-reasoning"
              >
                <Switch
                  id="pref-show-reasoning"
                  checked={prefs.showReasoning}
                  onCheckedChange={(v) => onUpdate({ showReasoning: v })}
                  aria-label="Show reasoning"
                />
              </Row>
            </Section>

            <Section icon={Cpu} title="Models & engine">
              <Row
                label="Engine"
                hint="Interactive keeps a live session per chat; print runs one-shot. Applies to new chats — an existing chat keeps the engine it started with."
              >
                <SegmentedControl
                  type="single"
                  value={prefs.engine}
                  onValueChange={(v) => v && onUpdate({ engine: v })}
                  aria-label="Engine"
                >
                  {ENGINE_OPTIONS.map((o) => (
                    <SegmentedControlItem key={o.value} value={o.value}>
                      {o.label}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </Row>
              <Row
                label="Default model"
                hint="Seeds new chats; change it per turn in the composer."
              >
                <PrefSelect
                  value={prefs.model}
                  options={MODEL_OPTIONS}
                  onValueChange={(v) => onUpdate({ model: v })}
                  ariaLabel="Default model"
                />
              </Row>
              <Row label="Default effort" hint="Higher effort engages extended thinking.">
                <PrefSelect
                  value={prefs.effort}
                  options={EFFORT_OPTIONS}
                  onValueChange={(v) => onUpdate({ effort: v })}
                  ariaLabel="Default effort"
                />
              </Row>
            </Section>

            <Section icon={Info} title="About">
              <p className="text-muted-foreground text-xs leading-relaxed">
                Genesis. Settings sync to your account and follow you across devices.
              </p>
            </Section>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
