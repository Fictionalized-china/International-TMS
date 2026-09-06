import { useEffect, useRef, useState, type ElementType, type FormEvent } from "react";
import { Form } from "react-router";
import {
  customerBusinessRoleLabel,
  customerBusinessRoles,
  type CustomerBusinessRoleCode,
} from "../lib/customer-business-roles";

export type CustomerEditorGeoReference = { code: string; name: string; parent_code: string | null };

export type CustomerEditorRecord = {
  id: string;
  code: string;
  identity_code: string;
  name: string;
  short_name: string | null;
  party_category: string;
  status: string;
  notes: string | null;
  sales_owner_user_id: string | null;
  primary_contact_name: string | null;
  primary_contact_title: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  default_address_country_code: string | null;
  default_address_state: string | null;
  default_address_city: string | null;
  default_address_line1: string | null;
};

export type CustomerEditorValues = {
  customerId?: string;
  code?: string;
  name?: string;
  shortName?: string;
  partyCategory?: string;
  businessRoles?: CustomerBusinessRoleCode[];
  ownerId?: string;
  status?: string;
  notes?: string;
  contactName?: string;
  contactTitle?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressCountryCode?: string;
  addressState?: string;
  addressCity?: string;
  addressLine1?: string;
  createPortal?: boolean;
  portalDisplayName?: string;
  portalEmail?: string;
  archiveContract?: boolean;
  contractTitle?: string;
  contractEffectiveAt?: string;
  contractExpiresAt?: string;
  contractNotes?: string;
};

type CustomerEditorTab = "profile" | "operations" | "portal" | "contract";

const partyCategories = [
  { value: "customer", label: "客户" },
  { value: "supplier", label: "供应商" },
  { value: "both", label: "客户与供应商" },
] as const;

function tabForErrors(errors?: Record<string, string>): CustomerEditorTab {
  const keys = Object.keys(errors ?? {});
  if (keys.some((key) => key.startsWith("portal"))) return "portal";
  if (keys.some((key) => key.startsWith("contract"))) return "contract";
  if (keys.some((key) => key === "profile" || key.startsWith("contact") || key.startsWith("address"))) return "operations";
  return "profile";
}

export function CustomerEditorForm({
  intent,
  customer,
  owners,
  countries,
  provinces,
  cities,
  busy,
  values,
  errors,
  formError,
  selectedRoles = [],
  formComponent,
  action,
}: {
  intent: "customer" | "customer_update";
  customer?: CustomerEditorRecord;
  owners: { id: string; display_name: string }[];
  countries: { code: string; name: string }[];
  provinces: CustomerEditorGeoReference[];
  cities: CustomerEditorGeoReference[];
  busy: boolean;
  values?: CustomerEditorValues;
  errors?: Record<string, string>;
  formError?: string;
  selectedRoles?: CustomerBusinessRoleCode[];
  formComponent?: ElementType;
  action?: string;
}) {
  const editing = intent === "customer_update";
  const FormRoot = formComponent ?? Form;
  const roles = values?.businessRoles ?? selectedRoles;
  const [activeTab, setActiveTab] = useState<CustomerEditorTab>(() => tabForErrors(errors));
  const [createPortal, setCreatePortal] = useState(Boolean(values?.createPortal));
  const [archiveContract, setArchiveContract] = useState(Boolean(values?.archiveContract));
  const errorFields = Object.keys(errors ?? {});
  const errorSummary = formError || (errorFields.length
    ? `请检查 ${errorFields.length} 处标记的必填或格式问题`
    : undefined);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!errorSummary) return;
    setActiveTab(tabForErrors(errors));
    const frame = window.requestAnimationFrame(() => {
      errorSummaryRef.current?.focus();
      errorSummaryRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errorSummary, errors]);

  const tabs: { id: CustomerEditorTab; label: string; hint: string }[] = [
    { id: "profile", label: "基本资料", hint: "必填" },
    { id: "operations", label: "联系与提货", hint: "必填" },
    ...(!editing ? [
      { id: "portal" as const, label: "门户账号", hint: "选填" },
      { id: "contract" as const, label: "合同归档", hint: "选填" },
    ] : []),
  ];

  const revealInvalidPanel = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const invalid = Array.from(form.elements).find((element) => {
      const control = element as unknown as { willValidate?: boolean; validity?: ValidityState };
      return Boolean(control.willValidate && control.validity && !control.validity.valid);
    }) as unknown as (HTMLElement & { reportValidity: () => boolean }) | undefined;
    if (!invalid) return;
    event.preventDefault();
    const tab = invalid.closest<HTMLElement>("[data-customer-tab]")?.dataset.customerTab as CustomerEditorTab | undefined;
    if (tab) setActiveTab(tab);
    window.requestAnimationFrame(() => {
      invalid.focus();
      invalid.reportValidity();
    });
  };

  return <FormRoot
    method="post"
    action={action}
    encType="multipart/form-data"
    className="customer-editor-form"
    data-enter-flow
    noValidate
    onSubmitCapture={revealInvalidPanel}
  >
    <input type="hidden" name="intent" value={intent} />
    {customer && <input type="hidden" name="customerId" value={customer.id} />}
    {errorSummary && <div ref={errorSummaryRef} className="alert error" role="alert" tabIndex={-1}><strong>客户资料尚未保存</strong><span>{errorSummary}</span><small>已填写内容仍保留，请按提示修改后重试。</small></div>}

    <div className={`customer-editor-tabs columns-${tabs.length}`} role="tablist" aria-label="客户资料分页">
      {tabs.map((tab) => <button
        key={tab.id}
        type="button"
        role="tab"
        id={`customer-editor-tab-${tab.id}`}
        aria-selected={activeTab === tab.id}
        aria-controls={`customer-editor-panel-${tab.id}`}
        className={activeTab === tab.id ? "active" : ""}
        onClick={() => setActiveTab(tab.id)}
      ><span>{tab.label}</span><small>{tab.hint}</small></button>)}
    </div>

    <section
      id="customer-editor-panel-profile"
      className="customer-editor-panel"
      role="tabpanel"
      aria-labelledby="customer-editor-tab-profile"
      data-customer-tab="profile"
      hidden={activeTab !== "profile"}
    >
      <div className="customer-form-section-title"><strong>客户基本资料</strong><span>代码选填；识别码创建后自动生成</span></div>
      <div className="customer-form-grid customer-basic-grid">
        <label className="field field-span-6"><span>客户全称</span><input name="name" required maxLength={120} defaultValue={values?.name ?? customer?.name}/>{errors?.name && <small className="field-error">{errors.name}</small>}</label>
        <label className="field field-span-3"><span>客商分类</span><select name="partyCategory" required defaultValue={values?.partyCategory ?? customer?.party_category ?? "customer"}><option value="">请选择</option>{partyCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{errors?.partyCategory && <small className="field-error">{errors.partyCategory}</small>}</label>
        <CustomerBusinessRolePicker selected={roles} error={errors?.businessRoles}/>
        <label className="field field-span-3"><span>客户简称 <em>选填</em></span><input name="shortName" maxLength={80} defaultValue={values?.shortName ?? customer?.short_name ?? ""}/></label>
        <label className="field field-span-3"><span>销售负责人 <em>选填</em></span><select name="ownerId" defaultValue={values?.ownerId ?? customer?.sales_owner_user_id ?? ""}><option value="">未指定</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.display_name}</option>)}</select>{errors?.ownerId && <small className="field-error">{errors.ownerId}</small>}</label>
        <label className="field field-span-3"><span>客户代码 <em>选填</em></span><input name="code" maxLength={40} placeholder="留空自动生成" defaultValue={values?.code ?? customer?.code}/>{errors?.code && <small className="field-error">{errors.code}</small>}</label>
        <label className="field field-span-3"><span>客户识别码</span><input value={customer?.identity_code ?? "创建后自动生成"} disabled/><small>{editing ? "不可修改" : "排除 O、0、1、L"}</small></label>
        {editing && <label className="field field-span-3"><span>状态</span><select name="status" required defaultValue={values?.status ?? customer?.status ?? "active"}><option value="active">正常</option><option value="suspended">暂停</option><option value="archived">归档</option></select>{errors?.status && <small className="field-error">{errors.status}</small>}</label>}
        <label className="field span-all"><span>备注 <em>选填</em></span><textarea name="notes" rows={3} maxLength={1000} defaultValue={values?.notes ?? customer?.notes ?? ""} placeholder="填写结算习惯、沟通偏好或其他客户说明"/></label>
      </div>
    </section>

    <section
      id="customer-editor-panel-operations"
      className="customer-editor-panel"
      role="tabpanel"
      aria-labelledby="customer-editor-tab-operations"
      data-customer-tab="operations"
      hidden={activeTab !== "operations"}
    >
      <div className="customer-form-section-title"><strong>默认联系人与提货地</strong><span>创建报价时将自动带入，仍可在单据中改选</span></div>
      <div className="customer-form-grid customer-contact-grid">
        <label className="field field-span-3"><span>联系人姓名</span><input name="contactName" required maxLength={80} defaultValue={values?.contactName ?? customer?.primary_contact_name ?? ""} placeholder="请输入联系人姓名" /></label>
        <label className="field field-span-3"><span>联系电话</span><input name="contactPhone" type="tel" inputMode="tel" pattern="[+0-9 \(\)\-]{6,30}" title="只能输入数字、空格、括号、短横线和开头的加号" required maxLength={30} defaultValue={values?.contactPhone ?? customer?.primary_contact_phone ?? ""} placeholder="请输入联系电话" /></label>
        <label className="field field-span-3"><span>职务 <em>选填</em></span><input name="contactTitle" maxLength={80} defaultValue={values?.contactTitle ?? customer?.primary_contact_title ?? ""}/></label>
        <label className="field field-span-3"><span>邮箱 <em>选填</em></span><input name="contactEmail" type="email" maxLength={254} defaultValue={values?.contactEmail ?? customer?.primary_contact_email ?? ""}/></label>
        <PickupAddressFields
          countries={countries}
          provinces={provinces}
          cities={cities}
          initialCountry={values?.addressCountryCode ?? customer?.default_address_country_code ?? "CN"}
          initialState={values?.addressState ?? customer?.default_address_state ?? ""}
          initialCity={values?.addressCity ?? customer?.default_address_city ?? ""}
        />
        <label className="field span-all"><span>详细提货地址</span><input name="addressLine1" required maxLength={240} defaultValue={values?.addressLine1 ?? customer?.default_address_line1 ?? ""} placeholder="街道、门牌号、园区和楼栋" /></label>
      </div>
      {errors?.profile && <small className="field-error customer-panel-error">{errors.profile}</small>}
    </section>

    {!editing && <section
      id="customer-editor-panel-portal"
      className="customer-editor-panel"
      role="tabpanel"
      aria-labelledby="customer-editor-tab-portal"
      data-customer-tab="portal"
      hidden={activeTab !== "portal"}
    >
      <div className="customer-form-section-title"><strong>客户门户账号</strong><span>可稍后在客户档案中开通</span></div>
      <div className="customer-form-grid">
        <label className="check-field span-all customer-addon-toggle"><input name="createPortal" type="checkbox" checked={createPortal} onChange={(event) => setCreatePortal(event.target.checked)}/><span><b>创建客户时同步开通门户</b><small>客户可确认报价、下载唛头并接收自提提醒</small></span></label>
        <label className="field field-span-3"><span>用户姓名</span><input name="portalDisplayName" autoComplete="name" required={createPortal} disabled={!createPortal} maxLength={80} defaultValue={values?.portalDisplayName ?? ""}/>{errors?.portalDisplayName && <small className="field-error">{errors.portalDisplayName}</small>}</label>
        <label className="field field-span-3"><span>登录邮箱</span><input name="portalEmail" type="email" autoComplete="email" required={createPortal} disabled={!createPortal} maxLength={254} defaultValue={values?.portalEmail ?? ""}/>{errors?.portalEmail && <small className="field-error">{errors.portalEmail}</small>}</label>
        <label className="field field-span-3"><span>初始密码</span><input name="portalPassword" type="password" autoComplete="new-password" required={createPortal} disabled={!createPortal} minLength={12} maxLength={128}/>{errors?.portalPassword && <small className="field-error">{errors.portalPassword}</small>}</label>
        <label className="field field-span-3"><span>确认密码</span><input name="portalConfirmPassword" type="password" autoComplete="new-password" required={createPortal} disabled={!createPortal} minLength={12} maxLength={128}/>{errors?.portalConfirmPassword && <small className="field-error">{errors.portalConfirmPassword}</small>}</label>
      </div>
    </section>}

    {!editing && <section
      id="customer-editor-panel-contract"
      className="customer-editor-panel"
      role="tabpanel"
      aria-labelledby="customer-editor-tab-contract"
      data-customer-tab="contract"
      hidden={activeTab !== "contract"}
    >
      <div className="customer-form-section-title"><strong>首份合同归档</strong><span>可稍后继续追加；单个文件不超过 1.2MB</span></div>
      <div className="customer-form-grid">
        <label className="check-field span-all customer-addon-toggle"><input name="archiveContract" type="checkbox" checked={archiveContract} onChange={(event) => setArchiveContract(event.target.checked)}/><span><b>创建客户时同步归档合同</b><small>合同只进入客户档案，不在每张订单中重复上传</small></span></label>
        <label className="field field-span-6"><span>合同名称</span><input name="contractTitle" required={archiveContract} disabled={!archiveContract} maxLength={120} defaultValue={values?.contractTitle ?? ""} placeholder="例如：2026 年度运输框架合同"/>{errors?.contractTitle && <small className="field-error">{errors.contractTitle}</small>}</label>
        <label className="field field-span-6"><span>合同文件</span><input name="contractAttachment" type="file" required={archiveContract} disabled={!archiveContract} accept="image/*,application/pdf"/>{errors?.contractAttachment && <small className="field-error">{errors.contractAttachment}</small>}</label>
        <label className="field field-span-3"><span>生效日期 <em>选填</em></span><input name="contractEffectiveAt" type="date" disabled={!archiveContract} defaultValue={values?.contractEffectiveAt ?? ""}/></label>
        <label className="field field-span-3"><span>到期日期 <em>选填</em></span><input name="contractExpiresAt" type="date" disabled={!archiveContract} defaultValue={values?.contractExpiresAt ?? ""}/>{errors?.contractDates && <small className="field-error">{errors.contractDates}</small>}</label>
        <label className="field field-span-6"><span>合同备注 <em>选填</em></span><textarea name="contractNotes" rows={3} disabled={!archiveContract} maxLength={1000} defaultValue={values?.contractNotes ?? ""} placeholder="填写合同编号、签署方和补充说明"/></label>
      </div>
    </section>}

    <div className="customer-form-actions"><span>{editing ? "保存后，报价和订单会读取最新的默认联系与提货资料。" : "一次保存客户、默认联系人和默认提货地；门户及合同按需同步创建。"}</span><button className="primary" disabled={busy}>{editing ? "确认保存客户信息" : "确认创建客户"}</button></div>
  </FormRoot>;
}

function CustomerBusinessRolePicker({ selected = [], error }: { selected?: CustomerBusinessRoleCode[]; error?: string }) {
  const [checkedRoles, setCheckedRoles] = useState<CustomerBusinessRoleCode[]>(selected);
  const selectedSet = new Set(checkedRoles);
  const missingRequiredRole = checkedRoles.length === 0;
  return <details
    className={`customer-role-dropdown field-span-3 ${missingRequiredRole ? "is-missing-required" : "is-complete"}${error ? " has-error" : ""}`}
    aria-required="true"
    aria-invalid={missingRequiredRole || Boolean(error)}
  >
    <summary><span>业务身份</span><strong>{checkedRoles.length ? checkedRoles.map(customerBusinessRoleLabel).join("、") : "请选择业务身份"}</strong></summary>
    <div className="customer-role-drawer"><p>可多选，用于发货人、收货人、代理、仓库等业务选择。</p><div className="customer-role-options">
      {customerBusinessRoles.map((item) => <label key={item.code}>
        <input
          type="checkbox"
          name="businessRoles"
          value={item.code}
          checked={selectedSet.has(item.code)}
          onChange={(event) => setCheckedRoles((current) => event.target.checked ? [...current, item.code] : current.filter((code) => code !== item.code))}
        />
        <span>{item.label}</span>
      </label>)}
    </div></div>
    {error && <small className="field-error">{error}</small>}
  </details>;
}

function PickupAddressFields({
  countries,
  provinces,
  cities,
  initialCountry = "",
  initialState = "",
  initialCity = "",
}: {
  countries: { code: string; name: string }[];
  provinces: CustomerEditorGeoReference[];
  cities: CustomerEditorGeoReference[];
  initialCountry?: string;
  initialState?: string;
  initialCity?: string;
}) {
  const [country, setCountry] = useState(initialCountry);
  const [state, setState] = useState(initialState);
  const [city, setCity] = useState(initialCity);
  const availableProvinces = provinces.filter((item) => item.parent_code === country);
  const availableCities = cities.filter((item) => item.parent_code === state);
  return <>
    <label className="field field-span-4"><span>国家/地区</span><select name="addressCountryCode" value={country} onChange={(event) => { setCountry(event.target.value); setState(""); setCity(""); }} required><option value="">请选择国家/地区</option>{countries.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label>
    <label className="field field-span-4"><span>省/州</span><select name="addressState" value={state} onChange={(event) => { setState(event.target.value); setCity(""); }} required disabled={!country}><option value="">请选择省/州</option>{availableProvinces.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
    <label className="field field-span-4"><span>城市</span><select name="addressCity" value={city} onChange={(event) => setCity(event.target.value)} required disabled={!state}><option value="">请选择城市</option>{availableCities.map((item) => <option key={item.code} value={item.name}>{item.name}</option>)}</select></label>
  </>;
}
