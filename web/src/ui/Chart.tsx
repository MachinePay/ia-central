import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/** Serie temporal leve (uPlot). x em segundos unix. */
export function TimeChart({ x, series, height = 200, label }: {
  x: number[];
  series: Array<{ label: string; values: Array<number | null>; color?: string; dash?: boolean; fill?: boolean }>;
  height?: number;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const axis = { stroke: css('--text-2'), grid: { stroke: css('--line'), width: 1 }, ticks: { stroke: css('--line') } };
    const plot = new uPlot({
      width: el.clientWidth || 600,
      height,
      cursor: { drag: { x: false, y: false } },
      legend: { show: true },
      axes: [axis, { ...axis, size: 60 }],
      series: [{}, ...series.map((s) => ({
        label: s.label, stroke: s.color ?? css('--cyan'), width: 2, dash: s.dash ? [6, 6] : undefined,
        fill: s.fill ? `${s.color ?? css('--cyan')}22` : undefined, spanGaps: true,
      }))],
    }, [x, ...series.map((s) => s.values)] as uPlot.AlignedData, el);
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => { ro.disconnect(); plot.destroy(); };
  }, [x, series, height]);
  return <div ref={ref} role="img" aria-label={label} className="w-full" />;
}
