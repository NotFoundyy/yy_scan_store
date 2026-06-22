// 操作审计动作的中文标签，前端展示与 Excel 导出共用，便于统一维护
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'box.create': '新建箱子',
  'box.update': '编辑箱子',
  'box.delete': '删除箱子',
  'item.create': '新增物品',
  'item.update': '编辑物品',
  'item.delete': '删除物品',
  'stock.in': '入库',
  'stock.out': '出库',
  'movement.update': '编辑流水',
  'movement.exclude': '清除领取记录',
  import: '导入箱子',
  restore: '恢复备份',
  'export.boxes': '导出箱子明细',
  'export.movements': '导出流水',
  'export.audit': '导出操作日志',
  'profile.update': '修改账号',
  'admin.reset_password': '重置用户密码',
  'admin.delete_user': '删除用户',
};

export const auditActionLabel = (action: string) => AUDIT_ACTION_LABELS[action] ?? action;

// 供筛选下拉使用的动作列表
export const AUDIT_ACTION_OPTIONS = Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label }));

export type AuditLog = {
  id: string;
  userId: string | null;
  username: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  ip: string | null;
  createdAt: string;
};
