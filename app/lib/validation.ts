export type FieldErrors = Record<string, string>;

export function valueOf(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value.trim() : "";
}

export function validateEmail(email: string): string | undefined {
  if (!email) return "请输入邮箱";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "邮箱格式不正确";
}

export function validatePassword(password: string): string | undefined {
  if (password.length < 12) return "密码至少需要 12 位";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return "密码必须包含大小写字母和数字";
  }
}

export function validateCode(code: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(code)) return "代码只能使用小写字母、数字和连字符（2-31 位）";
}
