import type { SupportMessage, SupportTicket } from '../types';

const statusMap: Record<string, SupportTicket['status']> = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  WAITING_FOR_CUSTOMER: 'waiting_customer',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

const toIso = (value: any) => value?.toDate?.().toISOString?.() || value || new Date().toISOString();

export function toUiTicket(serverTicket: any, messages: any[] = []): SupportTicket {
  return {
    id: serverTicket.id,
    ticketId: serverTicket.ticketId,
    customerId: serverTicket.customerId,
    customerName: serverTicket.customerName || '',
    subject: serverTicket.subject,
    category: serverTicket.category || 'Other',
    status: statusMap[serverTicket.status] || 'open',
    messages: messages.map((message): SupportMessage => ({
      id: message.id,
      senderId: message.senderId,
      senderName: message.senderRole === 'ADMIN' ? 'HerStep Support' : (message.senderName || ''),
      senderRole: message.senderRole === 'ADMIN' ? 'admin' : 'customer',
      content: message.body || '',
      attachments: message.attachments || [],
      timestamp: toIso(message.createdAt),
    })),
    createdAt: toIso(serverTicket.createdAt),
    updatedAt: toIso(serverTicket.updatedAt),
    ...(serverTicket.hasUnreadAdminMessages === undefined ? {} : { hasUnreadAdminMessages: Boolean(serverTicket.hasUnreadAdminMessages) }),
    ...(serverTicket.orderDocumentId ? { orderDocumentId: serverTicket.orderDocumentId } : {}),
  } as SupportTicket;
}
