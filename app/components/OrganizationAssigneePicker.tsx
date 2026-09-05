import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  buildOrganizationAssigneeTree,
  findOrganizationAssigneePath,
  type OrganizationAssigneeMember,
} from "../lib/organization-assignee";

type OrganizationAssigneePickerProps = {
  members: OrganizationAssigneeMember[];
  name: string;
  value?: string;
  defaultValue?: string;
  onChange?: (userId: string) => void;
  idPrefix?: string;
  className?: string;
  required?: boolean;
  disabled?: boolean;
  personLabel?: string;
  disabledUserReasons?: Readonly<Record<string, string>>;
};

type AssigneeCascadePlacement = {
  left: number;
  top: number;
  width: number;
  listHeight: number;
  direction: "above" | "below";
};

const EMPTY_DISABLED_USER_REASONS: Readonly<Record<string, string>> = {};

export function calculateAssigneeCascadePlacement(
  anchor: { top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
): AssigneeCascadePlacement {
  const margin = 8;
  const gap = 5;
  const headerAndBorderHeight = 33;
  const preferredListHeight = 224;
  const width = Math.min(660, Math.max(0, viewport.width - margin * 2));
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - margin - gap);
  const spaceAbove = Math.max(0, anchor.top - margin - gap);
  const preferredHeight = headerAndBorderHeight + preferredListHeight;
  const direction = spaceBelow >= preferredHeight || spaceBelow >= spaceAbove ? "below" : "above";
  const availableHeight = direction === "below" ? spaceBelow : spaceAbove;
  const listHeight = Math.max(96, Math.min(preferredListHeight, availableHeight - headerAndBorderHeight));
  const panelHeight = headerAndBorderHeight + listHeight;
  const left = Math.max(
    margin,
    Math.min(anchor.right - width, viewport.width - margin - width),
  );
  const top = direction === "below"
    ? Math.max(margin, Math.min(anchor.bottom + gap, viewport.height - margin - panelHeight))
    : Math.max(margin, anchor.top - gap - panelHeight);
  return { left, top, width, listHeight, direction };
}

export function OrganizationAssigneePicker({
  members,
  name,
  value,
  defaultValue = "",
  onChange,
  idPrefix,
  className = "",
  required = true,
  disabled = false,
  personLabel = "个人账户",
  disabledUserReasons = EMPTY_DISABLED_USER_REASONS,
}: OrganizationAssigneePickerProps) {
  const generatedId = useId().replace(/:/g, "");
  const baseId = idPrefix || `organization-assignee-${generatedId}`;
  const tree = useMemo(() => buildOrganizationAssigneeTree(members), [members]);
  const initialUserId = value ?? defaultValue;
  const initialPath = findOrganizationAssigneePath(members, initialUserId);
  const [departmentId, setDepartmentId] = useState(initialPath?.departmentId ?? "");
  const [positionId, setPositionId] = useState(initialPath?.positionId ?? "");
  const [internalUserId, setInternalUserId] = useState(initialPath?.userId ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const [cascadePlacement, setCascadePlacement] = useState<AssigneeCascadePlacement | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cascadeRef = useRef<HTMLDivElement>(null);
  const selectedUserId = value === undefined ? internalUserId : value;
  const selectedUserIsDisabled = Boolean(selectedUserId && disabledUserReasons[selectedUserId]);
  const effectiveSelectedUserId = selectedUserIsDisabled ? "" : selectedUserId;
  const selectedDepartment = tree.find((item) => item.id === departmentId);
  const positions = selectedDepartment?.positions ?? [];
  const selectedPosition = positions.find((item) => item.id === positionId);
  const people = selectedPosition?.members ?? [];
  const selectedPath = findOrganizationAssigneePath(members, effectiveSelectedUserId);
  const panelId = `${baseId}-cascade`;
  const assignableMembers = tree.flatMap((department) =>
    department.positions.flatMap((position) => position.members),
  );
  const disabledUserCount = assignableMembers.filter(
    (member) => Boolean(disabledUserReasons[member.id]),
  ).length;

  useEffect(() => {
    if (!selectedUserId) return;
    const nextPath = findOrganizationAssigneePath(members, selectedUserId);
    if (!nextPath || disabledUserReasons[selectedUserId]) {
      setDepartmentId("");
      setPositionId("");
      if (value === undefined) setInternalUserId("");
      onChange?.("");
      return;
    }
    setDepartmentId(nextPath.departmentId);
    setPositionId(nextPath.positionId);
  }, [disabledUserReasons, members, onChange, selectedUserId, value]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !cascadeRef.current?.contains(target)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setCascadePlacement(null);
      return;
    }
    const updatePlacement = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      setCascadePlacement(calculateAssigneeCascadePlacement(anchor, {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [isOpen]);

  const changeUser = (nextUserId: string) => {
    if (nextUserId && disabledUserReasons[nextUserId]) return;
    if (value === undefined) setInternalUserId(nextUserId);
    onChange?.(nextUserId);
  };

  return (
    <div
      ref={pickerRef}
      className={`organization-assignee-picker ${selectedPath ? "is-complete" : required ? "is-incomplete" : "is-empty"} ${isOpen ? "is-open" : ""} ${className}`.trim()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="organization-assignee-trigger"
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={disabled || !tree.length}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{personLabel}{required && <b className="required-mark"> *</b>}</span>
        <strong>
          {selectedPath
            ? `${selectedPath.departmentName} / ${selectedPath.positionName} / ${selectedPath.userName}`
            : `请选择部门 / 岗位 / ${personLabel}`}
        </strong>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {isOpen && cascadePlacement && createPortal(<div
        ref={cascadeRef}
        className="organization-assignee-cascade"
        id={panelId}
        role="group"
        aria-label={`选择${personLabel}`}
        data-direction={cascadePlacement.direction}
        style={{
          left: cascadePlacement.left,
          top: cascadePlacement.top,
          width: cascadePlacement.width,
          "--assignee-list-height": `${cascadePlacement.listHeight}px`,
        } as CSSProperties}
      >
        <OrganizationAssigneePanel
          title="1  部门"
          options={tree.map((department) => ({
            id: department.id,
            name: department.name,
            count: department.positions.reduce((sum, position) => sum + position.members.length, 0),
          }))}
          activeValue={departmentId}
          emptyText="暂无可派遣部门"
          showNext
          onSelect={(nextDepartmentId) => {
            setDepartmentId(nextDepartmentId);
            setPositionId("");
            changeUser("");
          }}
        />
        <OrganizationAssigneePanel
          title="2  岗位"
          options={positions.map((position) => ({
            id: position.id,
            name: position.name,
            count: position.members.length,
          }))}
          activeValue={positionId}
          emptyText={departmentId ? "该部门暂无可派遣岗位" : "请先选择部门"}
          showNext
          onSelect={(nextPositionId) => {
            setPositionId(nextPositionId);
            changeUser("");
          }}
        />
        <OrganizationAssigneePanel
          title={`3  ${personLabel}`}
          options={people.map((member) => ({
            id: member.id,
            name: member.display_name,
            disabled: Boolean(disabledUserReasons[member.id]),
            description: disabledUserReasons[member.id],
          }))}
          activeValue={effectiveSelectedUserId}
          emptyText={positionId ? "该岗位暂无可派遣个人账户" : "请先选择岗位"}
          onSelect={(nextUserId) => {
            changeUser(nextUserId);
            setIsOpen(false);
            triggerRef.current?.focus();
          }}
        />
      </div>, document.body)}
      <select
        className="organization-assignee-native-validator"
        id={`${baseId}-person`}
        aria-label={`已选择${personLabel}`}
        name={name}
        value={effectiveSelectedUserId}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        onChange={() => undefined}
        onInvalid={() => setIsOpen(true)}
      >
        <option value="" />
        {assignableMembers.map((member) => <option
          key={member.id}
          value={member.id}
          disabled={Boolean(disabledUserReasons[member.id])}
        >
          {member.display_name}{disabledUserReasons[member.id] ? "（原负责人，不可选）" : ""}
        </option>)}
      </select>
      <small className={selectedPath ? "organization-assignee-path ready" : "organization-assignee-path"}>
        {selectedPath
          ? `最终派给：${selectedPath.departmentName} / ${selectedPath.positionName} / ${selectedPath.userName}`
          : tree.length
            ? "必须选择到具体个人账户，部门和岗位仅用于定位。"
            : "暂无同时绑定部门和岗位的有效个人账户，请先维护组织成员。"}
      </small>
      {disabledUserCount > 0 && <small className="organization-assignee-exclusion-note">
        已禁用 {disabledUserCount} 名挂载订单原负责人；展开候选项可查看具体原因。
      </small>}
    </div>
  );
}

function OrganizationAssigneePanel({
  title,
  options,
  activeValue,
  emptyText,
  showNext = false,
  onSelect,
}: {
  title: string;
  options: { id: string; name: string; count?: number; disabled?: boolean; description?: string }[];
  activeValue: string;
  emptyText: string;
  showNext?: boolean;
  onSelect: (id: string) => void;
}) {
  return <section className="organization-assignee-panel">
    <header>{title}</header>
    {options.length ? <div className="organization-assignee-options" role="listbox" aria-label={title}>
      {options.map((option) => <button
        key={`${title}-${option.id}`}
        type="button"
        role="option"
        aria-selected={activeValue === option.id}
        aria-disabled={option.disabled || undefined}
        disabled={option.disabled}
        title={option.description}
        className={`${activeValue === option.id ? "selected" : ""}${option.disabled ? " disabled" : ""}`.trim()}
        onClick={() => onSelect(option.id)}
      >
        <span>{option.name}{option.count != null && <small>{option.count} 人</small>}{option.description && <small>{option.description}</small>}</span>
        {activeValue === option.id
          ? <Check aria-hidden="true" size={13} />
          : showNext && <ChevronRight aria-hidden="true" size={13} />}
      </button>)}
    </div> : <p>{emptyText}</p>}
  </section>;
}
