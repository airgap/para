<script lang="ts">
	import type { Notification } from '@lyku/json-models';
	import { api, getSessionId } from '@lyku/monolith-ts-api';
	import { onMount, untrack } from 'svelte';
	import { FeedPage } from '../FeedPage';
	import { Image } from '../Image';
	import { getStores } from '../CacheProvider';
	import { phrasebookStore } from '../phrasebook';
	import styles from './NotificationsPage.module.sass';

	type CategoryFilter = 'all' | 'mentions' | 'reactions' | 'social' | 'system';

	const CATEGORY_MAP: Record<CategoryFilter, string[]> = {
		all: [],
		mentions: ['mention', 'reply', 'forumReply'],
		reactions: ['like', 'tip', 'subscription'],
		social: [
			'follow',
			'friendRequest',
			'groupActivity',
			'voiceChannel',
			'collabDraft',
		],
		system: [
			'achievement',
			'levelUp',
			'streak',
			'recommendation',
			'marketplace',
			'plugin',
			'event',
			'stream',
			'story',
			'general',
			'botCommand',
			'quizResult',
		],
	};

	const stores = getStores();
	const phrasebook = $derived($phrasebookStore);
	const currentUser = $derived(stores.users.get(-1n));

	let activeCategory = $state<CategoryFilter>('all');
	let loading = $state(true);
	let loadingMore = $state(false);
	let offset = $state(0);
	let hasMore = $state(true);
	let deletingIds = $state(new Set<bigint>());
	let listEl: HTMLDivElement | undefined = $state();

	// All notifications excluding message notifications
	const allNotifications = $derived(
		[...stores.notifications.values()]
			.filter((n) => !n.href?.startsWith('/messages/'))
			.sort(
				(a, b) => new Date(b.posted).getTime() - new Date(a.posted).getTime(),
			),
	);

	// Filtered by active category
	const filteredNotifications = $derived(
		activeCategory === 'all'
			? allNotifications
			: allNotifications.filter((n) => {
					const cats = CATEGORY_MAP[activeCategory];
					return n.category && cats.includes(n.category);
				}),
	);

	// Unread counts per category
	const unreadCounts = $derived({
		all: allNotifications.filter((n) => !n.read).length,
		mentions: allNotifications.filter(
			(n) =>
				!n.read && n.category && CATEGORY_MAP.mentions.includes(n.category),
		).length,
		reactions: allNotifications.filter(
			(n) =>
				!n.read && n.category && CATEGORY_MAP.reactions.includes(n.category),
		).length,
		social: allNotifications.filter(
			(n) => !n.read && n.category && CATEGORY_MAP.social.includes(n.category),
		).length,
		system: allNotifications.filter(
			(n) => !n.read && n.category && CATEGORY_MAP.system.includes(n.category),
		).length,
	});

	const categories: { id: CategoryFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'mentions', label: 'Mentions' },
		{ id: 'reactions', label: 'Reactions' },
		{ id: 'social', label: 'Social' },
		{ id: 'system', label: 'System' },
	];

	onMount(() => {
		if (!getSessionId()) {
			loading = false;
			return;
		}
		// The root layout already kicks off a listNotifications fetch on mount
		// to populate the store for the badge/toast system. If those results
		// are already in memory, render them instantly and refresh silently
		// instead of blocking the page on a duplicate request.
		if (allNotifications.length > 0) {
			loading = false;
			offset = allNotifications.length;
		}
		loadNotifications();
	});

	// On a cold full-page load both the layout and page fetches race; whichever
	// returns first should clear the loading state so the user isn't stuck
	// staring at "Loading..." while data is already available.
	$effect(() => {
		if (allNotifications.length > 0 && untrack(() => loading)) {
			loading = false;
		}
	});

	async function loadNotifications() {
		try {
			const response = await api.listNotifications({ limit: 50 });
			response.notifications.forEach((n) => stores.notifications.set(n.id, n));
			hasMore = response.notifications.length >= 50;
			offset = response.notifications.length;
		} catch (error) {
			console.error('Failed to load notifications:', error);
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		try {
			const categoryFilter =
				activeCategory !== 'all' ? CATEGORY_MAP[activeCategory][0] : undefined;
			const response = await api.listNotifications({
				limit: 50,
				offset,
				category: categoryFilter,
			});
			response.notifications.forEach((n) => stores.notifications.set(n.id, n));
			hasMore = response.notifications.length >= 50;
			offset += response.notifications.length;
		} catch (error) {
			console.error('Failed to load more notifications:', error);
		} finally {
			loadingMore = false;
		}
	}

	function handleScroll(e: Event) {
		const el = e.target as HTMLElement;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
			loadMore();
		}
	}

	async function markAllRead() {
		try {
			await api.markNotificationsRead({});
			stores.notifications.forEach((notification, id) => {
				if (!notification.read) {
					stores.notifications.set(id, { ...notification, read: new Date() });
				}
			});
		} catch (error) {
			console.error('Failed to mark notifications as read:', error);
		}
	}

	async function clearAll() {
		try {
			await api.deleteNotifications({});
			stores.notifications.clear();
		} catch (error) {
			console.error('Failed to clear notifications:', error);
		}
	}

	async function deleteNotification(event: MouseEvent, notificationId: bigint) {
		event.stopPropagation();
		deletingIds.add(notificationId);
		deletingIds = new Set(deletingIds);
		try {
			await api.deleteNotifications({ notificationIds: [notificationId] });
			stores.notifications.delete(notificationId);
		} catch (error) {
			console.error('Failed to delete notification:', error);
		} finally {
			deletingIds.delete(notificationId);
			deletingIds = new Set(deletingIds);
		}
	}

	function handleNotificationClick(notification: Notification) {
		if (notification.href) {
			window.location.href = notification.href;
		}
	}

	function formatTime(posted: Date) {
		const date = new Date(posted);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffHours = diffMs / (1000 * 60 * 60);
		const diffDays = diffMs / (1000 * 60 * 60 * 24);

		if (diffHours < 1) {
			return phrasebook.notificationJustNow;
		} else if (diffHours < 24) {
			return phrasebook.notificationHoursAgo.replace(
				'{hours}',
				Math.floor(diffHours).toString(),
			);
		} else if (diffDays < 7) {
			return phrasebook.notificationDaysAgo.replace(
				'{days}',
				Math.floor(diffDays).toString(),
			);
		} else {
			return date.toLocaleDateString();
		}
	}
</script>

<FeedPage title={phrasebook.notificationsHeader}>
	{#snippet actions()}
		{#if unreadCounts.all > 0}
			<button class={styles.actionBtn} onclick={markAllRead}>
				{phrasebook.markAllReadButton}
			</button>
		{/if}
		{#if allNotifications.length > 0}
			<button class={styles.actionBtn} onclick={clearAll}>
				{phrasebook.clearButton}
			</button>
		{/if}
	{/snippet}

	<div class={styles.categoryTabs}>
		{#each categories as cat}
			<button
				class={[styles.categoryTab, activeCategory === cat.id && styles.active]}
				onclick={() => {
					activeCategory = cat.id;
				}}
			>
				{cat.label}
				{#if unreadCounts[cat.id] > 0}
					<span class={styles.tabBadge}>{unreadCounts[cat.id]}</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if !currentUser}
		<div class={styles.emptyState}>
			<p>{phrasebook.signInToViewNotifications}</p>
		</div>
	{:else if loading}
		<div class={styles.emptyState}>
			<p>{phrasebook.loadingNotifications}</p>
		</div>
	{:else if filteredNotifications.length === 0}
		<div class={styles.emptyState}>
			<p>{phrasebook.noNotificationsEmpty}</p>
		</div>
	{:else}
		<div
			class={styles.notificationList}
			bind:this={listEl}
			onscroll={handleScroll}
		>
			{#each filteredNotifications as notification (notification.id)}
				<div
					class={styles.notificationWrapper}
					style:opacity={deletingIds.has(notification.id) ? '0.5' : '1'}
				>
					<div
						class={[
							styles.notificationItem,
							!notification.read && styles.unread,
						]}
						role="button"
						tabindex="0"
						onclick={() => handleNotificationClick(notification)}
						onkeydown={(e) =>
							e.key === 'Enter' && handleNotificationClick(notification)}
					>
						<div
							class={[
								styles.notificationIcon,
								notification.autotheme && styles.autotheme,
							]}
						>
							<Image src={notification.icon} alt="" />
						</div>
						<div class={styles.notificationContent}>
							<div class={styles.notificationTitle}>{notification.title}</div>
							{#if notification.subtitle}
								<div class={styles.notificationSubtitle}>
									{notification.subtitle}
								</div>
							{/if}
							<div class={styles.notificationBody}>{notification.body}</div>
							<div class={styles.notificationTime}>
								{formatTime(notification.posted)}
							</div>
						</div>
						<div class={styles.notificationActions}>
							{#if notification.points}
								<span class={styles.pointsLabel}
									>{notification.points.toLocaleString()} XP</span
								>
								<button
									class={styles.claimBtn}
									onclick={(e) => deleteNotification(e, notification.id)}
									aria-label={phrasebook.claimPointsAriaLabel}
									disabled={deletingIds.has(notification.id)}
								>
									{phrasebook.claimButton}
								</button>
							{:else}
								<button
									class={styles.deleteBtn}
									onclick={(e) => deleteNotification(e, notification.id)}
									aria-label={phrasebook.deleteNotificationAriaLabel}
									disabled={deletingIds.has(notification.id)}
								>
									&times;
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/each}

			{#if loadingMore}
				<div class={styles.loadingMore}>Loading...</div>
			{/if}
		</div>
	{/if}
</FeedPage>
