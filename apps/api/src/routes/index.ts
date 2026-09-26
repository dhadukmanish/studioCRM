import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth';
import { roleRoutes } from './roles';
import { userRoutes } from './users';
import { orgRoutes } from './org';
import { customFieldRoutes } from './customFields';
import { settingsRoutes } from './settings';
import { prefRoutes } from './prefs';
import { itemRoutes } from './items';
import { subItemRoutes } from './subItems';
import { accountGroupRoutes } from './accountGroups';
import { accountRoutes } from './accounts';
import { bookRoutes } from './books';
import { appointmentRoutes } from './appointments';
import { billRoutes } from './bills';
import { invoiceTemplateRoutes } from './invoiceTemplates';
import { invoiceRoutes } from './invoices';
import { publicInvoiceRoutes } from './publicInvoice';
import { receiptRoutes } from './receipts';
import { receivableRoutes } from './receivables';
import { billReportRoutes } from './billReport';
import { workRoutes } from './work';

/** Register every route module here. Feature modules: add one line. */
export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(roleRoutes);
  await app.register(userRoutes);
  await app.register(orgRoutes);
  await app.register(customFieldRoutes);
  await app.register(settingsRoutes);
  await app.register(prefRoutes);
  await app.register(itemRoutes);
  await app.register(subItemRoutes);
  await app.register(accountGroupRoutes);
  await app.register(accountRoutes);
  await app.register(bookRoutes);
  await app.register(appointmentRoutes);
  await app.register(billRoutes);
  await app.register(invoiceTemplateRoutes);
  await app.register(invoiceRoutes);
  await app.register(receiptRoutes);
  await app.register(receivableRoutes);
  await app.register(billReportRoutes);
  await app.register(workRoutes);
  // The one anonymous invoice route (`/i/:token`) — token-scoped, no ERP session.
  await app.register(publicInvoiceRoutes);
}
