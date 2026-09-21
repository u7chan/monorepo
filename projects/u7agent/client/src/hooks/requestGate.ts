/** 後から開始した要求と、呼び出し元の lifecycle を優先する応答適用ガード。 */
export function createRequestGate() {
  let latest = 0;
  return (isActive: () => boolean = () => true) => {
    const request = ++latest;
    return () => isActive() && request === latest;
  };
}
