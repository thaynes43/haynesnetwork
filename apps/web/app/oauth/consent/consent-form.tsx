'use client';

// ADR-091 / DESIGN-050 D-05 step 6 / D-14 — Approve and Deny. Each button carries its OWN bound server action
// (never a shared action plus a button value — cigar-journal #29). ADR-015: both labels are fixed and both
// buttons reserve the same width, so nothing moves; while the decision is in flight both only disable (colour).
import { useFormStatus } from 'react-dom';

type Action = () => Promise<void>;

function Buttons({ approve, deny }: { approve: Action; deny: Action }) {
  const { pending } = useFormStatus();
  return (
    <>
      <button
        type="submit"
        className="btn primary oauth-actions__btn"
        formAction={approve}
        disabled={pending}
      >
        Approve
      </button>
      <button type="submit" className="btn oauth-actions__btn" formAction={deny} disabled={pending}>
        Deny
      </button>
    </>
  );
}

export function ConsentForm({ approve, deny }: { approve: Action; deny: Action }) {
  return (
    <form className="oauth-actions" data-testid="oauth-consent-form">
      <Buttons approve={approve} deny={deny} />
    </form>
  );
}
