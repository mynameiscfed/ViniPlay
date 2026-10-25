/**
 * notification.js
 ** Manages client-side logic for push notifications.
 * Handles subscribing/unsubscribing and interacts with the backend API.
 */

import { showNotification, showConfirm, navigate, openModal, closeModal } from './ui.js';
import { UIElements, guideState, appState } from './state.js';
import { handleSearchAndFilter, scrollToChannel, openProgramDetails } from './guide.js';
import { getVapidKey, subscribeToPush, addProgramNotification, getProgramNotifications, deleteProgramNotification, unsubscribeFromPush, clearPastNotifications } from './api.js';
import { ICONS } from './icons.js'; // MODIFIED: Import the new icon library
import { escapeHtml } from './utils.js';

let isSubscribed = false;

// Some TV browsers have no Notification API; treat that as blocked.
const notificationPermission = () => typeof Notification === 'undefined' ? 'denied' : Notification.permission;

const notificationChannel = new BroadcastChannel('viniplay-notifications');

notificationChannel.onmessage = (event) => {
    if (event.data && event.data.type === 'refresh-notifications') {
        console.log('[NOTIF_CHANNEL] Received refresh signal. Reloading notifications.');
        loadAndScheduleNotifications();
    }
};

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

/**
 * Unsubscribes the user from the current push subscription on this device.
 * @returns {Promise<boolean>} - True if successful or already unsubscribed.
 */
async function unsubscribeCurrentUser() {
    if (!appState.swRegistration) {
        console.warn('[NOTIF] Service worker not registered. Cannot unsubscribe.');
        return false;
    }
    try {
        const subscription = await appState.swRegistration.pushManager.getSubscription();
        if (subscription) {
            // MODIFIED: Pass the entire subscription object to the API wrapper.
            // The API function (unsubscribeFromPush) is responsible for extracting the endpoint.
            // This fixes a bug where `undefined` was being sent to the server.
            await unsubscribeFromPush(subscription); // Notify backend to delete this specific subscription.
            await subscription.unsubscribe(); // This removes the subscription from the browser itself.
            console.log('[NOTIF] User unsubscribed successfully from this device.');
        }
        isSubscribed = false;
        return true;
    } catch (error) {
        console.error('[NOTIF] Error during unsubscription:', error);
        return false;
    }
}

/**
 * Subscribes the user to push notifications. Handles both initial subscription and re-subscription.
 * @param {boolean} force - If true, will unsubscribe first before creating a new subscription.
 */
export async function subscribeUserToPush(force = false) {
    console.log(`[NOTIF] Initiating push subscription process. Force mode: ${force}`);
    if (!appState.swRegistration) {
        console.warn('[NOTIF] Service worker not registered yet. Cannot subscribe.');
        return;
    }

    if (force) {
        showNotification('Refreshing subscription...', false, 2000);
        await unsubscribeCurrentUser();
    }

    try {
        const subscription = await appState.swRegistration.pushManager.getSubscription();
        isSubscribed = (subscription !== null);

        if (isSubscribed && !force) { // MODIFIED: Added !force condition
            console.log('[NOTIF] User is already subscribed on this device.');
        } else {
            console.log('[NOTIF] User is NOT subscribed or re-subscription is forced. Attempting to subscribe...');
            const vapidPublicKey = await getVapidKey();
            if (!vapidPublicKey) {
                showNotification('Could not set up notifications: missing server key.', true);
                return;
            }
            const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

            const newSubscription = await appState.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });

            console.log('[NOTIF] New push subscription created for this device:', newSubscription);
            const success = await subscribeToPush(newSubscription);
            if (success) {
                isSubscribed = true;
                showNotification(force ? 'Re-subscribed successfully!' : 'Notifications enabled successfully!');
            } else {
                isSubscribed = false;
                showNotification('Failed to save subscription to server.', true);
            }
        }
    } catch (error) {
        console.error('[NOTIF] Failed to subscribe user:', error);
        if (notificationPermission() === 'denied') {
            showNotification('Notifications are blocked by your browser. Please enable them manually.', true, 8000);
        } else {
            showNotification('Failed to set up notifications. Check browser console.', true);
        }
        isSubscribed = false;
    }
}

export const loadAndScheduleNotifications = async () => {
    console.log('[NOTIF] Loading all scheduled notifications from backend.');
    try {
        const notifications = await getProgramNotifications();
        guideState.userNotifications = notifications;
        console.log(`[NOTIF] Loaded ${notifications.length} scheduled notifications from server.`);

        renderNotificationSettings();
        renderNotifications();
        renderPastNotifications();
        await handleSearchAndFilter(false, true);
    } catch (error) {
        console.error('[NOTIF] Error loading notifications:', error);
        showNotification('An error occurred loading notifications.', true);
    }
};

export const addOrRemoveNotification = async (programDetails) => {
    console.log(`[NOTIF] Add/remove for: ${programDetails.programTitle}`);
    const existingNotification = findNotificationForProgram(programDetails, programDetails.channelId);

    if (existingNotification) {
        showConfirm(
            'Remove Notification?',
            `Are you sure you want to remove the notification for "${escapeHtml(programDetails.programTitle)}"?`,
            async () => {
                if (await deleteProgramNotification(existingNotification.id)) {
                    showNotification(`Notification for "${programDetails.programTitle}" removed.`);
                    // --- **FIX: Refresh UI immediately** ---
                    // Post message for other tabs, then call directly to refresh the current tab.
                    notificationChannel.postMessage({ type: 'refresh-notifications' });
                    loadAndScheduleNotifications();
                }
            }
        );
    } else {
        if (notificationPermission() === 'denied') {
            showNotification('Notifications are blocked. Please enable them in site settings.', true, 8000);
            return;
        }

        if (notificationPermission() !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                showNotification('Permission denied. Cannot set alert.', true);
                return;
            }
        }

        await subscribeUserToPush();
        if (!isSubscribed) {
            showNotification('Could not subscribe to notifications. Cannot set alert.', true);
            return;
        }

        let notificationLeadTime = parseInt(guideState.settings.notificationLeadTime, 10);
        if (isNaN(notificationLeadTime)) {
            notificationLeadTime = 10;
        }

        const programStartTime = new Date(programDetails.programStart);
        if (isNaN(programStartTime.getTime())) {
            showNotification('Cannot set notification due to an invalid program start time.', true);
            return;
        }

        const scheduledTime = new Date(programStartTime.getTime() - notificationLeadTime * 60 * 1000);

        if (scheduledTime <= new Date()) {
            showNotification(`Cannot set notification for a program that has already started.`, true);
            return;
        }

        const newNotificationData = {
            channelId: programDetails.channelId,
            channelName: programDetails.channelName,
            channelLogo: programDetails.channelLogo,
            programTitle: programDetails.programTitle,
            programStart: programDetails.programStart,
            programStop: programDetails.programStop,
            programDesc: programDetails.programDesc,
            programId: programDetails.programId,
            scheduledTime: scheduledTime.toISOString()
        };

        if (await addProgramNotification(newNotificationData)) {
            showNotification(`Notification set for "${newNotificationData.programTitle}"!`);
            // --- **FIX: Refresh UI immediately** ---
            // Post message for other tabs, then call directly to refresh the current tab.
            notificationChannel.postMessage({ type: 'refresh-notifications' });
            loadAndScheduleNotifications();
        }
    }
};

export const findNotificationForProgram = (program, channelId) => {
    return guideState.userNotifications.find(n =>
        n.channelId === channelId &&
        n.programId === program.programId
    );
};

export const renderNotificationSettings = () => {
    const settingsEl = UIElements.notificationSettingsContainer; // Corrected element ID from UIElements
    if (!settingsEl) return;

    settingsEl.innerHTML = `<div class="lrow"><div class="t"><b>Not getting reminders on this device?</b><small>Re-subscribe this device to push notifications.</small></div><button id="force-resubscribe-btn" type="button" class="btn btn-ghost">Re-subscribe</button></div>`;

    const resubscribeBtn = document.getElementById('force-resubscribe-btn');
    resubscribeBtn?.addEventListener('click', () => subscribeUserToPush(true));
};

const dayTime = (value) => new Date(value).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const clockTime = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** One reminder row (upcoming or past): logo, programme, when, and the view / delete buttons. */
const reminderRow = (notif, detail) => {
    if (isNaN(new Date(notif.programStart)) || isNaN(new Date(notif.scheduledTime))) return '';
    return `<div class="lrow" data-notification-id="${escapeHtml(notif.id)}">
        <img class="ch-logo" src="${escapeHtml(notif.channelLogo)}" alt="" onerror="this.onerror=null;this.style.visibility='hidden'">
        <div class="t"><b>${escapeHtml(notif.programTitle || 'Untitled Program')}</b><small>${escapeHtml(notif.channelName || 'Unknown Channel')} · ${dayTime(notif.programStart)}</small><small class="note">${detail}</small></div>
        <button type="button" class="btn btn-ghost btn-icon view-program-btn" title="View in TV Guide" data-channel-id="${escapeHtml(notif.channelId)}" data-program-start="${escapeHtml(notif.programStart)}" data-program-id="${escapeHtml(notif.programId)}">${ICONS.goToGuide}</button>
        <button type="button" class="btn btn-ghost btn-icon delete-notification-btn" title="Delete Notification" data-notification-id="${escapeHtml(notif.id)}">${ICONS.trash}</button>
    </div>`;
};

export const renderNotifications = () => {
    const notificationListEl = UIElements.notificationsList;
    if (!notificationListEl) return;

    const now = new Date();
    const upcomingNotifications = guideState.userNotifications
        .filter(n => n.status === 'pending' && new Date(n.scheduledTime).getTime() > now.getTime())
        .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));

    UIElements.noNotificationsMessage.classList.toggle('hidden', upcomingNotifications.length > 0);

    // Count on the bell in the top bar.
    if (UIElements.reminderBadge) {
        UIElements.reminderBadge.textContent = upcomingNotifications.length > 99 ? '99+' : upcomingNotifications.length;
        UIElements.reminderBadge.classList.toggle('hidden', upcomingNotifications.length === 0);
    }

    notificationListEl.innerHTML = upcomingNotifications.map(notif => {
        const lead = Math.round((new Date(notif.programStart) - new Date(notif.scheduledTime)) / 60000);
        return reminderRow(notif, `Reminder at ${clockTime(notif.scheduledTime)} (${lead} min before)`);
    }).join('');

    setupNotificationListEventListeners();
};

export const renderPastNotifications = () => {
    const pastNotificationsListEl = UIElements.pastNotificationsList;
    if (!pastNotificationsListEl) return;

    const now = new Date();
    const pastNotifications = guideState.userNotifications
        .filter(n => new Date(n.scheduledTime).getTime() <= now.getTime())
        .sort((a, b) => new Date(b.scheduledTime) - new Date(a.scheduledTime))
        .slice(0, 20);

    // FIX: Corrected the logic to show the "no past notifications" message only when the list is empty.
    UIElements.noPastNotificationsMessage.classList.toggle('hidden', pastNotifications.length > 0);

    // Show/hide the "Clear All" button based on whether there are past notifications.
    UIElements.clearPastNotificationsBtn.classList.toggle('hidden', pastNotifications.length === 0);

    pastNotificationsListEl.innerHTML = pastNotifications.map(notif => {
        const at = clockTime(notif.triggeredAt || notif.scheduledTime);
        const status = notif.status === 'sent' ? 'Notified' : notif.status === 'expired' ? 'Expired' : 'Scheduled for';
        return reminderRow(notif, `${status} at ${at}`);
    }).join('');
};

const setupNotificationListEventListeners = () => {
    const handleClicks = (e) => {
        const deleteBtn = e.target.closest('.delete-notification-btn');
        const viewBtn = e.target.closest('.view-program-btn');

        if (deleteBtn) {
            const notificationId = deleteBtn.dataset.notificationId;
            const notification = guideState.userNotifications.find(n => n.id == notificationId);
            if (notification) {
                showConfirm(
                    'Delete Notification?',
                    `Are you sure you want to delete the notification for "${escapeHtml(notification.programTitle)}"?`,
                    async () => {
                        if (await deleteProgramNotification(notificationId)) {
                            notificationChannel.postMessage({ type: 'refresh-notifications' });
                            loadAndScheduleNotifications();
                        }
                    }
                );
            }
        } else if (viewBtn) {
            const { channelId, programStart, programId } = viewBtn.dataset;
            navigateToProgramInGuide(channelId, programStart, programId);
        }
    };

    UIElements.notificationsList?.removeEventListener('click', handleClicks);
    UIElements.pastNotificationsList?.removeEventListener('click', handleClicks);
    // NEW: Add event listener for the clear all button
    UIElements.clearPastNotificationsBtn?.removeEventListener('click', handleClearAllPast);

    UIElements.notificationsList?.addEventListener('click', handleClicks);
    UIElements.pastNotificationsList?.addEventListener('click', handleClicks);
    UIElements.clearPastNotificationsBtn?.addEventListener('click', handleClearAllPast);
};

// NEW: Handler function for the "Clear All" button
const handleClearAllPast = () => {
    showConfirm(
        'Clear All Past Notifications?',
        'This will remove all expired and sent notifications from your history. This action cannot be undone.',
        async () => {
            const success = await clearPastNotifications();
            if (success) {
                showNotification('Past notifications cleared successfully.');
                notificationChannel.postMessage({ type: 'refresh-notifications' });
                loadAndScheduleNotifications(); // Refresh the list
            } else {
                showNotification('Failed to clear past notifications.', true);
            }
        }
    );
};

export const navigateToProgramInGuide = async (channelId, programStart, programId) => {
    // MODIFIED: Set the navigation flag to true at the beginning of the process.
    appState.isNavigating = true;

    try {
        console.log(`[NOTIF_NAV] Attempting to navigate to program. Channel: ${channelId}, Start: ${programStart}`);

        // This function will wait until the guide data is loaded and rendered.
        const waitForGuideReady = () => {
            return new Promise((resolve) => {
                const maxAttempts = 100; // 10 seconds timeout
                let attempts = 0;
                const checkInterval = setInterval(() => {
                    // Check if the essential data and UI elements are ready
                    const isDataReady = guideState.channels.length > 0 && Object.keys(guideState.programs).length > 0;
                    const isUiReady = UIElements.guideGrid && UIElements.guideGrid.querySelector('.channel-info');

                    if (isDataReady && isUiReady) {
                        clearInterval(checkInterval);
                        console.log('[NOTIF_NAV] Guide is ready. Proceeding with navigation.');
                        resolve(true);
                    } else {
                        attempts++;
                        if (attempts >= maxAttempts) {
                            clearInterval(checkInterval);
                            console.error('[NOTIF_NAV] Timeout waiting for guide to become ready.');
                            resolve(false);
                        }
                    }
                }, 100); // Check every 100ms
            });
        };

        const isReady = await waitForGuideReady();
        if (!isReady) {
            showNotification("Could not navigate to program: Guide did not load in time.", true);
            return;
        }

        // The rest of the original logic can now execute safely.
        console.log(`[NOTIF_NAV] Navigating to program. Channel: ${channelId}, Start: ${programStart}`);
        const stableChannelIdSuffix = channelId.includes('_') ? '_' + channelId.split('_').pop() : channelId;

        // No need to navigate again if we are already on the guide page from the deep link
        if (window.location.pathname !== '/tvguide') {
            navigate('/tvguide');
            // Wait a moment for the page switch to happen visually.
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const targetProgramStart = new Date(programStart);

        // MODIFICATION: Create a new date object for comparison that ignores time, respecting timezone.
        const targetProgramDate = new Date(targetProgramStart.getFullYear(), targetProgramStart.getMonth(), targetProgramStart.getDate());
        const currentGuideDate = new Date(guideState.currentDate.getFullYear(), guideState.currentDate.getMonth(), guideState.currentDate.getDate());

        // If the program is on a different day, switch to that day first
        if (targetProgramDate.getTime() !== currentGuideDate.getTime()) {
            console.log(`[NOTIF_NAV] Program is on a different day. Switching guide date to ${targetProgramStart.toDateString()}`);
            guideState.currentDate = targetProgramStart;
            // This will re-render the guide for the correct day
            await handleSearchAndFilter(true);
        }

        // Scroll to the correct channel. This function already has a built-in wait mechanism.
        const channelScrolledAndRendered = await scrollToChannel(stableChannelIdSuffix);

        if (!channelScrolledAndRendered) {
            showNotification("Could not find the channel in the guide.", false, 6000);
            return;
        }

        // Now that we've scrolled and the row is rendered, find the specific channel and program elements.
        // We need to get the full, dynamic channel ID, as the one from the notification might just be the EPG part.
        const currentChannelElement = UIElements.guideGrid.querySelector(`.channel-info[data-id$="${stableChannelIdSuffix}"]`);
        if (!currentChannelElement) {
            showNotification("An unexpected error occurred while locating the channel element after scrolling.", true);
            return;
        }
        const currentDynamicChannelId = currentChannelElement.dataset.id;

        // Find the program element using its unique data attributes
        const programElement = UIElements.guideGrid.querySelector(
            `.programme-item[data-prog-start="${programStart}"][data-channel-id="${currentDynamicChannelId}"]`
        );

        if (!programElement) {
            showNotification("Could not find the specific program in the guide's timeline.", false, 6000);
            // It's possible the program is off-screen horizontally, so let's try to scroll horizontally.
            const guideContainer = UIElements.guideContainer;
            const guideStartUtc = new Date(guideState.currentDate);
            guideStartUtc.setHours(0, 0, 0, 0);
            const left = ((targetProgramStart.getTime() - guideStartUtc.getTime()) / 3600000) * guideState.hourWidthPixels;

            guideContainer.scrollTo({
                left: Math.max(0, left - (guideContainer.clientWidth / 4)),
                behavior: 'smooth'
            });
            // We don't try to open details here, as just getting the user to the right area is a good fallback.
            return;
        }

        // Scroll the program into the center of the view (both vertically and horizontally)
        const guideContainer = UIElements.guideContainer;
        const programRect = programElement.getBoundingClientRect();
        const containerRect = guideContainer.getBoundingClientRect();

        const desiredScrollTop = guideContainer.scrollTop + programRect.top - containerRect.top - (containerRect.height / 2) + (programRect.height / 2);
        const desiredScrollLeft = guideContainer.scrollLeft + programRect.left - containerRect.left - (containerRect.width / 2) + (programRect.width / 2);

        guideContainer.scrollTo({
            top: Math.max(0, desiredScrollTop),
            left: Math.max(0, desiredScrollLeft),
            behavior: 'smooth'
        });

        // Open details and highlight after a short delay to allow for the smooth scroll to complete.
        setTimeout(() => {
            openProgramDetails(programElement);
            programElement.classList.add('highlighted-search');
            setTimeout(() => { programElement.classList.remove('highlighted-search'); }, 2500);
        }, 300);
    } finally {
        // MODIFIED: Ensure the navigation flag is always reset, even if an error occurs.
        appState.isNavigating = false;
        console.log('[NOTIF_NAV] Navigation process finished. Resetting navigation flag.');
    }
};
