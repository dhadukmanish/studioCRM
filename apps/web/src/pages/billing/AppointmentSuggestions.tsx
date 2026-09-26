import { useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { normalizeMobile } from '@erp/shared';
import { Spinner } from '@/components/ui';
import { useAppointmentsLookup, type AppointmentLookup } from '@/lib/queries';
import { useDateFormatters } from '@/lib/settings';

/** Below this many digits a mobile is still being typed, not yet worth a lookup. */
const MIN_DIGITS = 4;
/** Long enough that a ten-digit number costs one request, short enough to feel immediate. */
const DEBOUNCE_MS = 350;

interface Props {
  /** The mobile exactly as the operator typed it; normalized and debounced in here. */
  mobile: string;
  /** The linked booking's number, or null for a walk-in. Owned by the form. */
  linked: number | null;
  onPick: (a: AppointmentLookup) => void;
  onClear: () => void;
  /** This bill's own next-visit appointment — the visit AFTER this bill, never the booking it came from. */
  excludeId?: string | null;
}

/**
 * The bridge between a booking and its bill.
 *
 * It offers CANDIDATES and never picks one — not even when there is exactly one. The same
 * mobile legitimately has several bookings (and a family shares a number), so only the
 * operator knows which one is being billed. A walk-in simply ignores this strip: typing the
 * customer's details by hand is the same amount of work it always was.
 *
 * While a booking is linked the candidate list is replaced by the chip, so the strip is one
 * line high during normal data entry. Clearing the chip brings the candidates back; it
 * removes only the LINK — the customer values already typed into the bill stay, because they
 * are the bill's own snapshot from the moment they land in the form.
 */
export function AppointmentSuggestions({ mobile, linked, onPick, onClear, excludeId }: Props) {
  const [digits, setDigits] = useState(() => normalizeMobile(mobile));
  useEffect(() => {
    const t = setTimeout(() => setDigits(normalizeMobile(mobile)), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [mobile]);

  const enough = digits.length >= MIN_DIGITS;
  // A linked bill asks nothing: the question "which booking is this?" is already answered.
  const q = useAppointmentsLookup(!linked && enough ? digits : '');
  const fmt = useDateFormatters();
  const rows = (q.data ?? []).filter((a) => a.id !== excludeId);

  if (linked !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="badge bg-primary-lighter text-primary-dark gap-1.5">
          <CalendarClock className="h-3.5 w-3.5" />
          From Appointment #{linked}
          <button type="button" onClick={onClear} aria-label={`Unlink appointment ${linked} from this bill`} className="rounded-full text-primary-dark/70 transition hover:text-primary-dark focus:outline-none focus:ring-2 focus:ring-primary/40">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
        <span className="text-[12px] text-gray-500">Unlinking keeps the customer details already on this bill.</span>
      </div>
    );
  }

  if (!enough) return null;
  if (q.isLoading) return <p className="flex items-center gap-1.5 text-[12px] text-gray-500"><Spinner className="h-3 w-3" /> Looking for bookings…</p>;
  if (q.isError) return <p className="text-[12px] text-red-600">Could not load bookings for this number.</p>;
  if (rows.length === 0) return <p className="text-[12px] text-gray-500">No booking found for this number — this bill will be saved as a walk-in.</p>;

  return (
    <div>
      <p className="mb-1 text-[12px] text-gray-500">{rows.length === 1 ? '1 booking found' : `${rows.length} bookings found`} — pick one to link it, or keep typing for a walk-in.</p>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onPick(a)}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12.5px] text-gray-700 transition hover:border-primary hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <CalendarClock className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <span className="font-medium text-gray-900">Appointment #{a.appointmentNumber}</span>
              <span className="text-gray-400">·</span>
              <span>{fmt.date(a.appointmentDate)}</span>
              {a.appointmentTime && <><span className="text-gray-400">·</span><span>{fmt.time(a.appointmentTime)}</span></>}
              <span className="text-gray-400">·</span>
              <span>{a.customerName}</span>
              {a.babyName && <><span className="text-gray-400">·</span><span className="text-gray-500">{a.babyName}</span></>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
