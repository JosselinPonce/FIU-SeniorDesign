export const DRIVER_INTRO_LAST_PAGE = 5;
export const driverIntroKey = (driverId: string) => `drivesense:intro:driver:${driverId}`;
export const newDriverIntro = JSON.stringify({ version: 1, page: 0, notices: false, completed: false });
