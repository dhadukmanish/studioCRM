import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatClockTime, formatDateOnly, formatTimestamp, toDateFormat, toTimeFormat, type CompanyProfile, type DateFormat, type TimeFormat } from '@erp/shared';
import { api } from '@/lib/api';
import { useSettings } from '@/lib/queries';

/**
 * Application-wide settings and branding, read through React Query so every screen shares ONE
 * cached copy per tenant: `['settings']` for application settings, `['companies', 'profile']`
 * for the company profile. Saving General Settings invalidates `settings`; saving a company or
 * its logo invalidates `companies`, which covers the profile. Nothing needs a reload.
 * See docs/SETTINGS.md.
 */

/** The tenant's display formats, falling back to the defaults while settings load or if a stored value is unknown. */
export function useDisplayFormats(): { dateFormat: DateFormat; timeFormat: TimeFormat } {
  const q = useSettings();
  return { dateFormat: toDateFormat(q.data?.dateFormat), timeFormat: toTimeFormat(q.data?.timeFormat) };
}

/**
 * The ONLY way a screen turns a stored date or time into text. Every function follows the
 * tenant's settings; none of them ever parses a business date through `new Date()`.
 *
 *   date(iso)       a business date "YYYY-MM-DD"      -> "25/09/2026"
 *   time(t)         a clock time "14:30[:00]"          -> "02:30 PM"
 *   stamp(ts)       an instant (created/updated at)    -> "25/09/2026"
 *   stampTime(ts)   an instant, with its local time    -> "25/09/2026 10:42 AM"
 */
export function useDateFormatters() {
  const { dateFormat, timeFormat } = useDisplayFormats();
  return useMemo(
    () => ({
      dateFormat,
      date: (v?: string | null) => formatDateOnly(v, dateFormat),
      time: (v?: string | null) => formatClockTime(v, timeFormat),
      stamp: (v?: string | Date | null) => formatTimestamp(v, { dateFormat }),
      stampTime: (v?: string | Date | null) => formatTimestamp(v, { dateFormat, timeFormat, withTime: true }),
    }),
    [dateFormat, timeFormat],
  );
}

/** The tenant's default company — the source of the name and logo the app brands itself with. */
export const useCompanyProfile = () =>
  useQuery({ queryKey: ['companies', 'profile'], queryFn: () => api.get<CompanyProfile | null>('/api/settings/company'), staleTime: 5 * 60_000 });

/** The logo's endpoint for one version of it. A new upload is a new version, so a new URL and a new cache entry. */
export const companyLogoUrl = (companyId: string, version: string) => `/api/admin/companies/${companyId}/logo?v=${encodeURIComponent(version)}`;

/**
 * A company logo as a data URL an <img> can show. The endpoint needs the bearer token, which an
 * <img src> cannot send, so it is fetched through the api client. Keyed by version, so it is
 * fetched once per upload and a replaced logo shows up at once.
 */
export function useCompanyLogo(companyId?: string | null, version?: string | null) {
  return useQuery({
    queryKey: ['company-logo', companyId, version],
    queryFn: async () => {
      const blob = await api.blob(companyLogoUrl(companyId!, version!));
      return await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
    },
    enabled: !!companyId && !!version,
    staleTime: Infinity,
    retry: false,
  });
}
