import { validatePassword } from "./validation";

export type WarehousePasswordResetInput = {
  accountId: string;
  password: string;
  confirmPassword: string;
};

export function warehousePasswordResetRequested(input: WarehousePasswordResetInput) {
  return Boolean(input.accountId || input.password || input.confirmPassword);
}

export function validateWarehousePasswordReset(input: WarehousePasswordResetInput) {
  if (!warehousePasswordResetRequested(input)) return null;
  if (!input.accountId) return "请选择需要修改密码的仓库账号";
  if (!input.password || !input.confirmPassword) return "请完整填写新密码和确认密码";
  const passwordError = validatePassword(input.password);
  if (passwordError) return passwordError;
  if (input.password !== input.confirmPassword) return "两次输入的新密码不一致";
  return null;
}
