"use client";

import { createContext, useContext } from "react";
import type { MeResponse } from "./types";

/**
 * Level-1 permissions of the signed-in user (from /auth/me), so screens can hide menus and
 * buttons the user lacks. The backend enforces the same rules; this only keeps the UI honest.
 */
export interface Perms {
  me: MeResponse | null;
  can: (code: string, action?: string) => boolean;
}

/**
 * Object codes of the server's ObjectCatalog. The /auth/me matrix already resolves inheritance for
 * each of them (PermissionService.matrix), so they are looked up exactly — walking up to "RH" would
 * let a view-only root grant unlock admin areas the backend forbids. Only codes outside the catalog
 * fall back to their nearest catalog ancestor.
 */
const CATALOG = new Set([
  "RH", "RH.OVERVIEW", "RH.REPORT", "RH.REPORT.PARAMETER", "RH.OUTPUT", "RH.QUEUE", "RH.INTEGRATION",
  "RH.DATASOURCE", "RH.REPOSITORY", "RH.REPOSITORY.REGISTRY", "RH.ADHOC", "RH.DATASET", "RH.PIPELINE",
  "RH.CHAIN", "RH.CHECK", "RH.SCHEDULER", "RH.DASHBOARD", "RH.DOCUMENT", "RH.ENGINE", "RH.RESOURCE",
  "RH.SETTINGS", "RH.ACCESS",
]);

export function permsFrom(me: MeResponse | null): Perms {
  const matrix = me?.permissions;
  return {
    me,
    can: (code, action = "view") => {
      if (!me) return false;
      if (me.admin || me.role === "ADMIN") return true;
      if (!matrix) return true; // older backend: no matrix, let the server decide
      let c: string | null = code;
      while (c && !CATALOG.has(c)) {
        const i: number = c.lastIndexOf(".");
        c = i < 0 ? null : c.slice(0, i);
      }
      return !!c && !!matrix[c]?.includes(action);
    },
  };
}

export const PermsContext = createContext<Perms>(permsFrom(null));
export const usePerms = () => useContext(PermsContext);
