// Shared API envelope + pagination types

export interface ApiSuccess<T> {
  message: string;
  data: T;
}
export interface ApiError {
  error: { code: string; message: string; details?: unknown; timestamp: string };
}
export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ListQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
  firmId?: string;
  branchId?: string;
}
