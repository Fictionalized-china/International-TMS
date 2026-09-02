import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
};

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
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedUserId = value === undefined ? internalUserId : value;
  const selectedDepartment = tree.find((item) => item.id === departmentId);
  const positions = selectedDepartment?.positions ?? [];
  const selectedPosition = positions.find((item) => item.id === positionId);
  const people = selectedPosition?.members ?? [];
  const selectedPath = findOrganizationAssigneePath(members, selectedUserId);
  const panelId = `${baseId}-cascade`;

  useEffect(() => {
    if (!selectedUserId) return;
    const nextPath = findOrganizationAssigneePath(members, selectedUserId);
    if (!nextPath) {
      setDepartmentId("");
      setPositionId("");
      if (value === undefined) setInternalUserId("");
      onChange?.("");
      return;
    }
    setDepartmentId(nextPath.departmentId);
    setPositionId(nextPath.positionId);
  }, [members, onChange, selectedUserId, value]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setIsOpen(false);
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

  const changeUser = (nextUserId: string) => {
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
      {isOpen && <div
        className="organization-assignee-cascade"
        id={panelId}
        role="group"
        aria-label={`选择${personLabel}`}
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
          options={people.map((member) => ({ id: member.id, name: member.display_name }))}
          activeValue={selectedUserId}
          emptyText={positionId ? "该岗位暂无可派遣个人账户" : "请先选择岗位"}
          onSelect={(nextUserId) => {
            changeUser(nextUserId);
            setIsOpen(false);
            triggerRef.current?.focus();
          }}
        />
      </div>}
      <select
        className="organization-assignee-native-validator"
        id={`${baseId}-person`}
        aria-label={`已选择${personLabel}`}
        name={name}
        value={selectedUserId}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        onChange={() => undefined}
        onInvalid={() => setIsOpen(true)}
      >
        <option value="" />
        {selectedPath && <option value={selectedUserId}>{selectedPath.userName}</option>}
      </select>
      <small className={selectedPath ? "organization-assignee-path ready" : "organization-assignee-path"}>
        {selectedPath
          ? `最终派给：${selectedPath.departmentName} / ${selectedPath.positionName} / ${selectedPath.userName}`
          : tree.length
            ? "必须选择到具体个人账户，部门和岗位仅用于定位。"
            : "暂无同时绑定部门和岗位的有效个人账户，请先维护组织成员。"}
      </small>
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
  options: { id: string; name: string; count?: number }[];
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
        className={activeValue === option.id ? "selected" : ""}
        onClick={() => onSelect(option.id)}
      >
        <span>{option.name}{option.count != null && <small>{option.count} 人</small>}</span>
        {activeValue === option.id
          ? <Check aria-hidden="true" size={13} />
          : showNext && <ChevronRight aria-hidden="true" size={13} />}
      </button>)}
    </div> : <p>{emptyText}</p>}
  </section>;
}
