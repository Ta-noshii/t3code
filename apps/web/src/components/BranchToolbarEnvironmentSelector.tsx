import type { EnvironmentId } from "@t3tools/contracts";
import { CopyIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { CloneTargetOption, EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  // Absent when there is only one environment to show: the indicator still
  // renders (as a static label) so remote projects are always identifiable.
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  // A started chat stays where it is; picking another environment clones it there.
  cloneTargets?: readonly CloneTargetOption[] | undefined;
  onCloneToEnvironment?: ((target: CloneTargetOption) => void) | undefined;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  cloneTargets,
  onCloneToEnvironment,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment = useMemo(() => {
    return availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  }, [availableEnvironments, environmentId]);

  const environmentItems = useMemo(
    () => [
      ...(onAutoEnvironment
        ? [{ value: "auto", label: autoEnvironmentLabel ?? "Auto balance" }]
        : []),
      ...availableEnvironments.map((env) => ({
        value: env.environmentId,
        label: env.label,
      })),
    ],
    [availableEnvironments, autoEnvironmentLabel, onAutoEnvironment],
  );

  // The static label carries the xs control's height (h-7 sm:h-6) as well as
  // its padding: the composer context strip has no min-height of its own, and
  // the glass seam joining it to the composer assumes a fixed strip height, so
  // a shorter label would drag the seam out of line whenever this label is the
  // only thing in the strip.
  if (envLocked && cloneTargets && cloneTargets.length > 0 && onCloneToEnvironment) {
    return (
      <CloneEnvironmentSelector
        activeEnvironment={activeEnvironment}
        cloneTargets={cloneTargets}
        onCloneToEnvironment={onCloneToEnvironment}
      />
    );
  }

  if (envLocked || onEnvironmentChange === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span />}
          className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
          data-composer-context-control
        >
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className="size-3 shrink-0"
          />
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {activeEnvironment?.label ?? "Run on"}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={autoEnvironmentLabel ? "auto" : environmentId}
      onValueChange={(value) =>
        value === "auto" ? onAutoEnvironment?.() : onEnvironmentChange(value as EnvironmentId)
      }
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              <SelectValue />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value="auto"
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem key={env.environmentId} value={env.environmentId}>
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

const CURRENT_ENVIRONMENT_VALUE = "current";

/** Environment picker for a started chat: the current environment plus clone targets. */
function CloneEnvironmentSelector({
  activeEnvironment,
  cloneTargets,
  onCloneToEnvironment,
}: {
  activeEnvironment: EnvironmentOption | null;
  cloneTargets: readonly CloneTargetOption[];
  onCloneToEnvironment: (target: CloneTargetOption) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const label = activeEnvironment?.label ?? "Run on";
  const items = useMemo(
    () => [
      { value: CURRENT_ENVIRONMENT_VALUE, label },
      ...cloneTargets.map((target, index) => ({
        value: String(index),
        label: target.projectLabel
          ? `${target.environmentLabel} · ${target.projectLabel}`
          : target.environmentLabel,
      })),
    ],
    [cloneTargets, label],
  );
  const sameProjectTargets = cloneTargets.flatMap((target, index) =>
    target.projectLabel === null ? [{ target, index }] : [],
  );
  const otherProjectGroups = new Map<
    EnvironmentId,
    Array<{ target: CloneTargetOption; index: number }>
  >();
  cloneTargets.forEach((target, index) => {
    if (target.projectLabel === null) return;
    const group = otherProjectGroups.get(target.environmentId) ?? [];
    group.push({ target, index });
    otherProjectGroups.set(target.environmentId, group);
  });
  const renderTarget = ({ target, index }: { target: CloneTargetOption; index: number }) => (
    <SelectItem key={index} value={String(index)} disabled={!target.connected}>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <EnvironmentMachineIcon kind={target.machine} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{target.projectLabel ?? target.environmentLabel}</span>
        {target.connected ? null : <span className="text-muted-foreground/70">offline</span>}
      </span>
    </SelectItem>
  );

  return (
    <Select
      modal={false}
      value={CURRENT_ENVIRONMENT_VALUE}
      onValueChange={(value) => {
        const target = value === null ? undefined : cloneTargets[Number(value)];
        if (value !== CURRENT_ENVIRONMENT_VALUE && target) onCloneToEnvironment(target);
      }}
      items={items}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Environment, or clone this chat to another"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className="size-3 shrink-0"
          />
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              <SelectValue />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>{`${label} · pick another environment to clone this chat there`}</TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Running on</SelectGroupLabel>
          <SelectItem value={CURRENT_ENVIRONMENT_VALUE}>
            <span className="inline-flex items-center gap-1.5">
              <EnvironmentMachineIcon
                kind={activeEnvironment?.machine ?? "server"}
                className="size-3"
              />
              {label}
            </span>
          </SelectItem>
        </SelectGroup>
        {sameProjectTargets.length > 0 ? (
          <SelectGroup>
            <SelectGroupLabel>
              <span className="inline-flex items-center gap-1.5">
                <CopyIcon className="size-3" aria-hidden="true" />
                Clone chat to
              </span>
            </SelectGroupLabel>
            {sameProjectTargets.map(renderTarget)}
          </SelectGroup>
        ) : null}
        {Array.from(otherProjectGroups.values(), (group) => (
          <SelectGroup key={group[0]!.target.environmentId}>
            <SelectGroupLabel>
              <span className="inline-flex items-center gap-1.5">
                <CopyIcon className="size-3" aria-hidden="true" />
                Clone chat to {group[0]!.target.environmentLabel}
              </span>
            </SelectGroupLabel>
            {group.map(renderTarget)}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}
