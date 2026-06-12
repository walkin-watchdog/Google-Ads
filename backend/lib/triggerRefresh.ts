export type TriggerRefreshWindow = {
    startDate: any;
    endDate: any;
    defaultedToToday: boolean;
};

export type TriggerRefreshRequest = {
    startDate: any;
    endDate: any;
    lightClientRefresh: boolean;
    scheduledCronRefresh: boolean;
};

type RefreshCooldownResult = {
    status?: string;
    skipped?: boolean;
    cooldownRemainingMs?: number;
};

function hasDateInput(value: any): boolean {
    return value !== undefined && value !== null && value !== '';
}

export function utcDateKey(now = new Date()): string {
    if (!Number.isFinite(now.getTime())) throw new Error('Unable to determine today for the refresh window.');
    return now.toISOString().slice(0, 10);
}

export function resolveTriggerRefreshWindow(body: any, now = new Date()): TriggerRefreshWindow {
    const startDate = body?.startDate;
    const endDate = body?.endDate;
    if (hasDateInput(startDate) || hasDateInput(endDate)) {
        return { startDate, endDate, defaultedToToday: false };
    }

    const today = utcDateKey(now);
    return {
        startDate: today,
        endDate: today,
        defaultedToToday: true
    };
}

export function resolveTriggerRefreshRequest(
    body: any,
    { force = false, now = new Date() }: { force?: boolean; now?: Date } = {}
): TriggerRefreshRequest {
    const requestedWindow = resolveTriggerRefreshWindow(body, now);
    const explicitSingleDay = hasDateInput(requestedWindow.startDate)
        && requestedWindow.startDate === requestedWindow.endDate;
    const lightClientRefresh = body?.refreshProfile === 'light_today'
        && (requestedWindow.defaultedToToday || explicitSingleDay);
    const scheduledCronRefresh = requestedWindow.defaultedToToday && !lightClientRefresh && !force;
    return {
        startDate: lightClientRefresh ? requestedWindow.startDate : body?.startDate,
        endDate: lightClientRefresh ? requestedWindow.endDate : body?.endDate,
        lightClientRefresh,
        scheduledCronRefresh
    };
}

export function shouldRunCronCooldownLightRefresh(
    refreshRequest: TriggerRefreshRequest,
    result: RefreshCooldownResult
): boolean {
    return refreshRequest.scheduledCronRefresh
        && result?.status === 'skipped'
        && result?.skipped === true
        && Number(result?.cooldownRemainingMs || 0) > 0;
}
