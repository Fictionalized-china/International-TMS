import { isValidCustomerIdentityCode } from "./customer-identity";
import { validateEmail, validatePassword, validatePhone, type FieldErrors } from "./validation";

export type PortalRegistrationInput = {
  companyName: string;
  customerIdentityCode: string;
  displayName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  acceptedTerms: boolean;
};

export function validatePortalRegistration(input: PortalRegistrationInput): FieldErrors {
  const errors: FieldErrors = {};
  if (input.companyName.length < 2 || input.companyName.length > 160)
    errors.companyName = "企业名称应为 2-160 个字符";
  if (input.customerIdentityCode && !isValidCustomerIdentityCode(input.customerIdentityCode))
    errors.customerIdentityCode = "客户识别码应为 5 位字母与数字，且不包含 O、0、1、L";
  if (input.displayName.length < 2 || input.displayName.length > 80)
    errors.displayName = "联系人姓名应为 2-80 个字符";
  const emailError = validateEmail(input.email);
  if (emailError) errors.email = emailError;
  if (input.phone) {
    const phoneError = validatePhone(input.phone);
    if (phoneError) errors.phone = phoneError;
  }
  const passwordError = validatePassword(input.password);
  if (passwordError) errors.password = passwordError;
  if (input.password !== input.confirmPassword) errors.confirmPassword = "两次输入的密码不一致";
  if (!input.acceptedTerms) errors.acceptedTerms = "请确认注册资料真实并同意账号绑定审核";
  return errors;
}

export function portalRegistrationLoginMessage(status: string | null, reviewNotes?: string | null) {
  if (status === "pending") return "注册申请正在审核中；后台完成客户绑定后即可登录。";
  if (status === "rejected")
    return reviewNotes?.trim()
      ? `注册申请未通过：${reviewNotes.trim()}`
      : "注册申请未通过，请联系业务人员核对客户资料。";
  return "该账号尚未绑定客户，请联系业务人员处理。";
}
