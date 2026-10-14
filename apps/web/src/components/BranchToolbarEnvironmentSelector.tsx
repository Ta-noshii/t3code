import { ComposerControl, ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, ScaleIcon } from "lucide-react";
import { memo, useMemo } from "react";

import type { CopyTargetOption, EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
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
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  /** A started chat stays where it runs; picking a project elsewhere copies it there. */
  copyTargets?: readonly CopyTargetOption[] | undefined;
  onCopyToEnvironment?: ((target: CopyTargetOption) => void) | undefined;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  copyTargets,
  onCopyToEnvironment,
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
  if (envLocked && copyTargets && copyTargets.length > 0 && onCopyToEnvironment) {
    return (
      <CopyEnvironmentSelector
        activeEnvironment={activeEnvironment}
        copyTargets={copyTargets}
        onCopyToEnvironment={onCopyToEnvironment}
      />
    );
  }

  if (envLocked || onEnvironmentChange === undefined) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>{activeEnvironment?.label ?? "Run on"}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
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
            <ComposerSelectControl
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
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
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
 * Menu body for a started chat: the machine it runs on, then one submenu per
 * other environment listing the projects the chat can be copied into.
 */
export function CopyEnvironmentMenuContent({
  activeEnvironment,
  copyTargets,
  onCopyToEnvironment,
}: {
  activeEnvironment: EnvironmentOption | null;
  copyTargets: readonly CopyTargetOption[];
  onCopyToEnvironment: (target: CopyTargetOption) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const groups = new Map<EnvironmentId, CopyTargetOption[]>();
  for (const target of copyTargets) {
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
                    <MenuItem key={target.projectId} onClick={() => onCopyToEnvironment(target)}>
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

/** Environment chip of a started chat. Opens the copy menu. */
function CopyEnvironmentSelector({
  activeEnvironment,
  copyTargets,
  onCopyToEnvironment,
}: {
  activeEnvironment: EnvironmentOption | null;
  copyTargets: readonly CopyTargetOption[];
  onCopyToEnvironment: (target: CopyTargetOption) => void;
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
          <ComposerContextLabel>{label}</ComposerContextLabel>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </TooltipTrigger>
        <TooltipPopup>{`Runs on ${label}. Click to copy this chat to another machine.`}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
        <CopyEnvironmentMenuContent
          activeEnvironment={activeEnvironment}
          copyTargets={copyTargets}
          onCopyToEnvironment={onCopyToEnvironment}
        />
      </MenuPopup>
    </Menu>
  );
}
