import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { CloneTargetOption, EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
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

/**
 * Menu body for a started chat: where it runs now, then one submenu per other environment
 * listing the projects the chat can be copied into.
 */
export function CloneEnvironmentMenuContent({
  activeEnvironment,
  cloneTargets,
  onCloneToEnvironment,
}: {
  activeEnvironment: EnvironmentOption | null;
  cloneTargets: readonly CloneTargetOption[];
  onCloneToEnvironment: (target: CloneTargetOption) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const groups = new Map<EnvironmentId, CloneTargetOption[]>();
  for (const target of cloneTargets) {
    const group = groups.get(target.environmentId) ?? [];
    group.push(target);
    groups.set(target.environmentId, group);
  }

  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>This chat runs on</MenuGroupLabel>
        <MenuItem>
          <EnvironmentMachineIcon kind={activeEnvironment?.machine ?? "server"} />
          <span className="min-w-0 flex-1 truncate">{activeEnvironment?.label ?? "Unknown"}</span>
          <CheckIcon className="ms-3" />
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Copy this chat to another machine</MenuGroupLabel>
        {Array.from(groups.values(), (targets) => {
          const first = targets[0]!;
          if (!first.connected) {
            return (
              <MenuItem key={first.environmentId} disabled>
                <EnvironmentMachineIcon kind={first.machine} />
                <span className="min-w-0 flex-1 truncate">{first.environmentLabel}</span>
                <span className="ms-3 text-muted-foreground text-xs">offline</span>
              </MenuItem>
            );
          }
          return (
            <MenuSub key={first.environmentId}>
              <MenuSubTrigger>
                <EnvironmentMachineIcon kind={first.machine} />
                <span className="min-w-0 flex-1 truncate">{first.environmentLabel}</span>
              </MenuSubTrigger>
              <MenuSubPopup {...composerFloatingLayerProps}>
                <MenuGroup>
                  <MenuGroupLabel>Into project</MenuGroupLabel>
                  {targets.map((target) => (
                    <MenuItem key={target.projectId} onClick={() => onCloneToEnvironment(target)}>
                      <FolderIcon />
                      <span className="min-w-0 flex-1 truncate">{target.projectLabel}</span>
                      {target.sameProject ? (
                        <span className="ms-3 text-muted-foreground text-xs">same project</span>
                      ) : null}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        })}
      </MenuGroup>
    </>
  );
}

/** Environment chip for a started chat. Opens the copy menu. */
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

  return (
    <Menu modal={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              className="min-w-0 max-w-full"
              aria-label={`Runs on ${label}. Copy this chat to another machine`}
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
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {label}
            </span>
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </TooltipTrigger>
        <TooltipPopup>{`Runs on ${label}. Click to copy this chat to another machine.`}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
        <CloneEnvironmentMenuContent
          activeEnvironment={activeEnvironment}
          cloneTargets={cloneTargets}
          onCloneToEnvironment={onCloneToEnvironment}
        />
      </MenuPopup>
    </Menu>
  );
}
