import { ApiSettings } from "@/app/components/api-settings";
import { ConverterStudio } from "@/app/components/converter-studio";

export default function Page() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-ink text-xs font-semibold tracking-wide text-white">
              SC
            </span>
            <div>
              <p className="text-sm font-semibold tracking-tight text-ink">숏컷</p>
              <p className="text-xs text-muted">롱폼을 1분 숏폼 영상으로</p>
            </div>
          </div>
          <ApiSettings />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-10 sm:px-8 sm:py-14">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-accent">01 영상 · 02 구간 · 03 편집</p>
          <h1 className="mt-3 text-4xl leading-tight font-semibold tracking-tight text-ink sm:text-5xl">
            롱폼을 1분 숏폼 영상으로 자동 제작
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted">
            유튜브 원본에서 가장 센 30초~1분을 골라, 9:16 세로 화면에 줌과 강조
            자막을 입혀 쇼츠로 자릅니다.
          </p>
        </div>

        <div className="mt-10">
          <ConverterStudio />
        </div>
      </main>
    </div>
  );
}
