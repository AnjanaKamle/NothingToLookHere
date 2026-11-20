import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearEnrollment, loadEnrollment } from '../services/credentials';
import { deleteDeviceKey, hasDeviceKey } from '../services/deviceKey';

const EnrollmentContext = createContext(null);

/**
 * Holds whether this phone is enrolled. The enrollment record is kept in secure storage; only
 * the non-secret parts and the device token are held in memory while the app runs.
 */
export function EnrollmentProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', enrollment: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let enrollment = null;
      try {
        enrollment = await loadEnrollment();
        // A stored record without its hardware key (e.g. after an iOS restore) is useless.
        if (enrollment && !(await hasDeviceKey())) {
          await clearEnrollment();
          enrollment = null;
        }
      } catch {
        enrollment = null;
      }
      if (!cancelled) setState({ status: enrollment ? 'enrolled' : 'unenrolled', enrollment });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnrollment = useCallback((enrollment) => {
    setState({ status: 'enrolled', enrollment });
  }, []);

  /** Forgets this phone locally: deletes the key and the stored record. */
  const forgetThisPhone = useCallback(async () => {
    await deleteDeviceKey().catch(() => {});
    await clearEnrollment().catch(() => {});
    setState({ status: 'unenrolled', enrollment: null });
  }, []);

  const value = useMemo(
    () => ({ ...state, setEnrollment, forgetThisPhone }),
    [state, setEnrollment, forgetThisPhone],
  );
  return <EnrollmentContext.Provider value={value}>{children}</EnrollmentContext.Provider>;
}

export function useEnrollment() {
  const value = useContext(EnrollmentContext);
  if (!value) throw new Error('useEnrollment must be used inside EnrollmentProvider');
  return value;
}
