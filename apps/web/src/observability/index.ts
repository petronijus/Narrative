/**
 * observability/index.ts
 *
 * Public exports pro observability modul.
 */

export type { FpsStats, FpsTracker } from './fpsTracker.js'
export { createFpsTracker } from './fpsTracker.js'

export type { YjsMetrics, YjsMetricsTracker } from './yjsMetrics.js'
export { createYjsMetrics } from './yjsMetrics.js'

export { MetricsDashboard, FpsOnlyDashboard } from './metricsDashboard.js'
export { useDevMetrics } from './useDevMetrics.js'
