export type FieldErrors = Record<string, string>;

export function valueOf(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value.trim() : "";
}

export function validateEmail(email: string): string | undefined {
  if (!email) return "请输入邮箱";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "邮箱格式不正确";
}

export function validatePhone(phone: string, label = "联系电话"): string | undefined {
  if (!phone) return `请输入${label}`;
  const plusIsValid = !phone.includes("+") || (phone.startsWith("+") && !phone.slice(1).includes("+"));
  if (phone.length > 30 || !/^[+0-9\s()\-]+$/.test(phone) || !plusIsValid) {
    return `${label}只能包含数字、空格、括号、短横线和开头的加号`;
  }
  const digitCount = phone.replace(/\D/g, "").length;
  if (digitCount < 6 || digitCount > 20) return `${label}应包含 6-20 位数字`;
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

export function requirePositiveNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

export function requirePositiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是大于 0 的整数`);
  return number;
}
