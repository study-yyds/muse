import { useRef, useCallback } from "react";

/** 节流：delay 毫秒内只执行一次 */
export function useThrottle<T extends (...args: any[]) => void>(fn: T, delay = 800) {
  const lastRef = useRef(0);
  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastRef.current < delay) return;
      lastRef.current = now;
      fn(...args);
    },
    [fn, delay],
  );
}
