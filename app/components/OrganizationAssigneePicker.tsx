import { useEffect, useId, useMemo, useState } from "react";
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
  const selectedUserId = value === undefined ? internalUserId : value;
  const selectedDepartment = tree.find((item) => item.id === departmentId);
  const positions = selectedDepartment?.positions ?? [];
  const selectedPosition = positions.find((item) => item.id === positionId);
  const people = selectedPosition?.members ?? [];
  const selectedPath = findOrganizationAssigneePath(members, selectedUserId);

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

  const changeUser = (nextUserId: string) => {
    if (value === undefined) setInternalUserId(nextUserId);
    onChange?.(nextUserId);
  };

  return (
    <div className={`organization-assignee-picker ${className}`.trim()}>
      <label htmlFor={`${baseId}-department`}>
        <span>部门</span>
        <select
          id={`${baseId}-department`}
          aria-label="选择部门"
          value={departmentId}
          required={required}
          disabled={disabled || !tree.length}
          onChange={(event) => {
            setDepartmentId(event.currentTarget.value);
            setPositionId("");
            changeUser("");
          }}
        >
          <option value="">选择部门</option>
          {tree.map((department) => (
            <option key={department.id} value={department.id}>{department.name}</option>
          ))}
        </select>
      </label>
      <span className="organization-assignee-arrow" aria-hidden="true">→</span>
      <label htmlFor={`${baseId}-position`}>
        <span>岗位</span>
        <select
          id={`${baseId}-position`}
          aria-label="选择岗位"
          value={positionId}
          required={required}
          disabled={disabled || !departmentId}
          onChange={(event) => {
            setPositionId(event.currentTarget.value);
            changeUser("");
          }}
        >
          <option value="">选择岗位</option>
          {positions.map((position) => (
            <option key={position.id} value={position.id}>{position.name}</option>
          ))}
        </select>
      </label>
      <span className="organization-assignee-arrow" aria-hidden="true">→</span>
      <label htmlFor={`${baseId}-person`}>
        <span>{personLabel}</span>
        <select
          id={`${baseId}-person`}
          aria-label={`选择${personLabel}`}
          name={name}
          value={selectedUserId}
          required={required}
          disabled={disabled || !positionId}
          onChange={(event) => changeUser(event.currentTarget.value)}
        >
          <option value="">选择{personLabel}</option>
          {people.map((member) => (
            <option key={member.id} value={member.id}>{member.display_name}</option>
          ))}
        </select>
      </label>
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
