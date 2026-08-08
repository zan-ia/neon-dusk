import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AttributeKey, RoundInfoResponse, RoundStatus } from "@neon-dusk/shared";
import { ATTRIBUTE_KEYS, BASE_ATTRIBUTES, SOFT_CAP } from "@neon-dusk/shared";
import { useAuthStore } from "@/stores/auth";
import { ATTRIBUTE_LABELS, ORIGIN_LABELS, ROLE_LABELS } from "@/lib/labels";
import { formatCountdown } from "@/lib/format";
import { api } from "@/api/client";
import Leaderboard from "@/components/Leaderboard";

/** Translate round status to Portuguese display label. */
const ROUND_STATUS_LABEL: Record<RoundStatus, string> = {
  active: "ATIVO",
  ended: "ENCERRADO",
  intermission: "INTERVALO",
};

/**
 * Runner dashboard: character card, NIL bar with live regen countdown,
 * syn-café stim and logout (port of DashboardView.vue).
 */
export default function DashboardView() {
  const navigate = useNavigate();
  const character = useAuthStore((s) => s.character);
  const user = useAuthStore((s) => s.user);
  const nilStatus = useAuthStore((s) => s.nilStatus);
  const nilLoading = useAuthStore((s) => s.nilLoading);
  const nilError = useAuthStore((s) => s.nilError);
  const fetchNil = useAuthStore((s) => s.fetchNil);
  const useStim = useAuthStore((s) => s.useStim);
  const logout = useAuthStore((s) => s.logout);

  const attributeHighlight = (key: AttributeKey) =>
    (character?.[key] ?? 0) >= SOFT_CAP
      ? "text-nd-magenta"
      : (character?.[key] ?? 0) > BASE_ATTRIBUTES
        ? "text-nd-cyan"
        : "text-nd-text";

  // --- NIL (Feature #2) — bar color by charge + regen countdown ----------------

  const nilPercent = useMemo(
    () => (nilStatus && nilStatus.max > 0 ? Math.round((nilStatus.current / nilStatus.max) * 100) : 0),
    [nilStatus],
  );

  const nilBarColor = useMemo(() => {
    if (nilPercent < 20) return "bg-nd-magenta";
    if (nilPercent < 50) return "bg-nd-gold";
    return "bg-nd-cyan";
  }, [nilPercent]);

  const [countdown, setCountdown] = useState(0);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [roundInfo, setRoundInfo] = useState<RoundInfoResponse | null>(null);

  useEffect(() => {
    api.get<RoundInfoResponse>("/api/round").then(setRoundInfo).catch(() => {
      // Round info unavailable — keep the null state which shows nothing.
    });
  }, []);

  function syncCountdown(): void {
    setCountdown(useAuthStore.getState().nilStatus?.nextTickSeconds ?? 0);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetchNil();
      if (cancelled) return;
      syncCountdown();
      countdownTimer.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev > 0) return prev - 1;
          // Regen tick landed — refresh to display the accrued NIL.
          const nil = useAuthStore.getState().nilStatus;
          if (nil?.regenerating) {
            void useAuthStore.getState().fetchNil();
            return nil.nextTickSeconds;
          }
          return prev;
        });
      }, 1000);
    })();
    return () => {
      cancelled = true;
      if (countdownTimer.current) {
        clearInterval(countdownTimer.current);
        countdownTimer.current = null;
      }
    };
  }, [fetchNil]);

  async function onUseStim(): Promise<void> {
    try {
      await useStim();
      syncCountdown();
    } catch {
      // error already surfaced through nilError
    }
  }

  async function onLogout(): Promise<void> {
    await logout();
    navigate("/login");
  }

  return (
    <div className="py-8 space-y-6">
      {/* Session header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-heading text-2xl text-nd-cyan tracking-widest">PAINEL DO CORREDOR</h2>
          <p className="text-nd-text-secondary text-sm">
            Conectado como <span className="font-data text-nd-text">{user?.email}</span>
          </p>
        </div>
        <button className="btn-danger text-xs self-start" onClick={() => void onLogout()}>
          Desconectar
        </button>
      </div>

      {character ? (
        <>
          <div className="card space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <h3 className="font-heading text-3xl text-nd-gold">{character.name}</h3>
                <p className="text-nd-text-secondary font-data text-sm mt-1">
                  {ROLE_LABELS[character.role]} · Origem: {ORIGIN_LABELS[character.origin]}
                </p>
              </div>
              {roundInfo && (
                <span className="self-start font-data text-xs uppercase tracking-widest border border-nd-cyan/40 text-nd-cyan rounded-terminal px-2 py-1">
                  ROUND {roundInfo.roundNumber} // {ROUND_STATUS_LABEL[roundInfo.status]}
                </span>
              )}
            </div>

            {/* NIL — neural load bar (Feature #2) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-data text-xs uppercase tracking-widest text-nd-text-secondary">
                    NIL // CARGA NEURAL
                  </span>
                  <span className="font-data text-sm text-nd-text">
                    {nilStatus?.current ?? 0} / {nilStatus?.max ?? 0}
                  </span>
                </div>
                <button
                  className="btn-neon text-xs px-3 py-1"
                  disabled={nilLoading || !nilStatus?.regenerating}
                  onClick={() => void onUseStim()}
                >
                  SYN-CAFÉ
                </button>
              </div>
              <div className="h-2 w-full bg-nd-bg overflow-hidden rounded-full border border-nd-cyan/20">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${nilBarColor}`}
                  style={{ width: `${nilPercent}%` }}
                ></div>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs font-data">
                {nilStatus?.regenerating ? (
                  <span className="text-nd-text-secondary">
                    Próximo +1 em {formatCountdown(countdown)}
                  </span>
                ) : (
                  <span className="text-nd-cyan">NIL CHEIO</span>
                )}
                {nilError && <span className="text-nd-magenta text-right">{nilError}</span>}
              </div>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {ATTRIBUTE_KEYS.map((key) => (
                  <div
                    key={key}
                    className={`bg-nd-bg/60 border rounded-terminal p-3 text-center transition-colors ${
                      character[key] >= SOFT_CAP
                        ? "border-nd-gold/40 shadow-[0_0_6px_rgba(255,204,0,0.15)]"
                        : "border-nd-cyan/20"
                    }`}
                  >
                    <div className="text-nd-text-secondary text-xs font-data uppercase tracking-wider">
                      {ATTRIBUTE_LABELS[key]}
                    </div>
                    <div className={`font-data text-3xl mt-1 ${attributeHighlight(key)}`}>
                      {character[key]}
                    </div>
                    {character[key] >= SOFT_CAP && (
                      <div className="text-nd-gold/60 text-[10px] font-data mt-1 leading-tight" title="Após 15, cada ponto custa 2">
                        SOFT CAP
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p className="text-nd-text-secondary text-xs font-data">
            <Link to="/gigs" className="text-nd-purple hover:text-nd-cyan transition-colors">
              ▸ Quadro de gigs — Cupim, o Porteiro
            </Link>
          </p>

          <Leaderboard />
        </>
      ) : (
        <div className="card text-center space-y-3">
          <p className="text-nd-text-secondary">Nenhum personagem vinculado a esta conta.</p>
          <Link to="/create-character" className="btn-neon inline-block">
            Criar personagem
          </Link>
        </div>
      )}
    </div>
  );
}
