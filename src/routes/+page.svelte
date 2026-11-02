<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	let mapContainer: HTMLDivElement;

	type Vehicle = {
		id: string;
		latitude: number;
		longitude: number;
		bearing: number | null;
		routeId: string | null;
		tripId: string | null;
	};

	onMount(() => {
		let map: import('maplibre-gl').Map | undefined;
		let interval: ReturnType<typeof setInterval> | undefined;
		let animationFrame: number | undefined;
		let destroyed = false;

		const previousPositions = new SvelteMap<
			string,
			{
				latitude: number;
				longitude: number;
				bearing: number | null;
			}
		>();

		function estimateBearing(vehicle: Vehicle): number | null {
			const previous = previousPositions.get(vehicle.id);

			let bearing = vehicle.bearing;

			if (previous && bearing === null) {
				const lat = (vehicle.latitude * Math.PI) / 180;

				const east = (vehicle.longitude - previous.longitude) * Math.cos(lat);

				const north = vehicle.latitude - previous.latitude;

				const distance = Math.hypot(east, north) * 111320;

				if (distance > 15) {
					// Only update if bus has moved more than 15 meters
					bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
				} else {
					// Stationary so keep the previous known direction
					return previous.bearing;
				}
			}

			previousPositions.set(vehicle.id, {
				latitude: vehicle.latitude,
				longitude: vehicle.longitude,
				bearing
			});

			return bearing;
		}

		function createBusIcon(directional: boolean): ImageData {
			const canvas = document.createElement('canvas');
			canvas.width = 64;
			canvas.height = 64;

			const ctx = canvas.getContext('2d')!;

			ctx.fillStyle = '#155e75';
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 4;
			ctx.lineJoin = 'round';

			ctx.beginPath();

			if (directional) {
				// Arrow pointing north (0°)
				ctx.moveTo(32, 8);
				ctx.lineTo(48, 49);
				ctx.lineTo(32, 40);
				ctx.lineTo(16, 49);
				ctx.closePath();
			} else {
				// Circle for buses with unknown bearing
				ctx.arc(32, 32, 18, 0, Math.PI * 2);
			}

			ctx.fill();
			ctx.stroke();

			return ctx.getImageData(0, 0, 64, 64);
		}

		async function init() {
			const maplibregl = await import('maplibre-gl');

			if (destroyed) return;

			const instance = new maplibregl.Map({
				container: mapContainer,
				style: 'https://tiles.openfreemap.org/styles/positron',
				center: [153.0251, -27.4698],
				zoom: 11
			});

			map = instance;

			instance.addControl(new maplibregl.NavigationControl(), 'top-right');

			instance.on('load', () => {
				if (destroyed) return;

				// Create an initially empty vehicle source
				instance.addSource('buses', {
					type: 'geojson',
					data: {
						type: 'FeatureCollection',
						features: []
					}
				});

				// Register the icons
				instance.addImage('bus-direction', createBusIcon(true), { pixelRatio: 2 });

				instance.addImage('bus-unknown', createBusIcon(false), { pixelRatio: 2 });

				// Draw directional bus markers
				instance.addLayer({
					id: 'buses',
					type: 'symbol',
					source: 'buses',

					layout: {
						'icon-image': [
							'case',
							['==', ['get', 'bearing'], null],
							'bus-unknown',
							'bus-direction'
						],
						'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.65, 12, 0.9, 16, 1.2],
						'icon-rotate': ['coalesce', ['get', 'bearing'], 0],
						'icon-rotation-alignment': 'map',
						'icon-allow-overlap': true
					}
				});

				const displayed = new SvelteMap<string, Vehicle>();
				const targets = new SvelteMap<string, Vehicle>();

				const animations = new SvelteMap<
					string,
					{
						from: Vehicle;
						to: Vehicle;
						start: number;
					}
				>();

				const ANIMATION_DURATION = 16000;
				const FRAME_INTERVAL = 100; // 10 FPS

				let lastFrame = 0;

				const source = instance.getSource('buses') as import('maplibre-gl').GeoJSONSource;

				// Interpolate headings via the shortest rotation
				function interpolateBearing(
					from: number | null,
					to: number | null,
					t: number
				): number | null {
					if (from === null) return to;
					if (to === null) return from;

					const difference = ((to - from + 540) % 360) - 180;

					return (from + difference * t + 360) % 360;
				}

				// Draw the current animated positions
				function renderFrame(now: number) {
					animationFrame = undefined;

					if (destroyed) return;

					if (now - lastFrame < FRAME_INTERVAL) {
						animationFrame = requestAnimationFrame(renderFrame);
						return;
					}

					for (const [id, animation] of animations) {
						const t = Math.min(1, (now - animation.start) / ANIMATION_DURATION);

						const { from, to } = animation;

						displayed.set(id, {
							...to,

							latitude: from.latitude + (to.latitude - from.latitude) * t,

							longitude: from.longitude + (to.longitude - from.longitude) * t,

							bearing: interpolateBearing(from.bearing, to.bearing, t)
						});

						if (t >= 1) {
							animations.delete(id);
						}
					}

					// Update all bus markers in one operation
					source.setData({
						type: 'FeatureCollection',
						features: Array.from(displayed.values(), (vehicle) => ({
							type: 'Feature' as const,

							geometry: {
								type: 'Point' as const,
								coordinates: [vehicle.longitude, vehicle.latitude]
							},

							properties: {
								id: vehicle.id,
								routeId: vehicle.routeId,
								tripId: vehicle.tripId,
								bearing: vehicle.bearing
							}
						}))
					});

					lastFrame = now;

					// Only keep animating while something is moving
					if (animations.size > 0) {
						animationFrame = requestAnimationFrame(renderFrame);
					}
				}

				function scheduleRender() {
					if (animationFrame === undefined) {
						animationFrame = requestAnimationFrame(renderFrame);
					}
				}

				// Fetch fresh GPS positions
				async function updateVehicles() {
					try {
						const response = await fetch('/api/vehicles');

						if (!response.ok) {
							throw new Error(`HTTP ${response.status}`);
						}

						const { vehicles } = (await response.json()) as {
							vehicles: Vehicle[];
						};

						if (destroyed) return;

						const now = performance.now();
						const receivedIds = new SvelteSet<string>();

						for (const incoming of vehicles) {
							const vehicle: Vehicle = {
								...incoming,
								bearing: estimateBearing(incoming)
							};

							receivedIds.add(vehicle.id);

							const previousTarget = targets.get(vehicle.id);

							// Ignore unchanged GPS readings
							if (
								previousTarget &&
								previousTarget.latitude === vehicle.latitude &&
								previousTarget.longitude === vehicle.longitude &&
								previousTarget.bearing === vehicle.bearing
							) {
								continue;
							}

							const current = displayed.get(vehicle.id);

							if (current) {
								// Approximate distance to detect GPS jumps
								const lat = (vehicle.latitude * Math.PI) / 180;

								const north = (vehicle.latitude - current.latitude) * 111_320;

								const east = (vehicle.longitude - current.longitude) * Math.cos(lat) * 111_320;

								const distance = Math.hypot(north, east);

								if (distance < 1000) {
									animations.set(vehicle.id, {
										from: current,
										to: vehicle,
										start: now
									});
								} else {
									// Large jump: reposition without animating
									displayed.set(vehicle.id, vehicle);
									animations.delete(vehicle.id);
								}
							} else {
								// New bus: display immediately
								displayed.set(vehicle.id, vehicle);
							}

							targets.set(vehicle.id, vehicle);
						}

						// Remove buses that disappeared from the feed
						for (const id of displayed.keys()) {
							if (!receivedIds.has(id)) {
								displayed.delete(id);
								targets.delete(id);
								animations.delete(id);
							}
						}

						scheduleRender();

						console.log(`Updated ${vehicles.length} buses`);
					} catch (error) {
						console.error('Failed to update buses:', error);
					}
				}

				// Initial fetch
				updateVehicles();

				// Refresh every 15 seconds
				interval = setInterval(() => {
					updateVehicles();
				}, 15000);

				// Handle clicking a bus
				instance.on('click', 'buses', (event) => {
					const feature = event.features?.[0];

					if (!feature || feature.geometry.type !== 'Point') {
						return;
					}

					const { id, routeId, tripId } = feature.properties;

					new maplibregl.Popup({ offset: 10 })
						.setLngLat(event.lngLat)
						.setText(
							`Bus: ${id}\nRoute ID: ${routeId ?? 'Unknown'}\nTrip ID: ${tripId ?? 'Unknown'}`
						)
						.addTo(instance);
				});

				// Pointer cursor when hovering over a bus
				instance.on('mouseenter', 'buses', () => {
					instance.getCanvas().style.cursor = 'pointer';
				});

				instance.on('mouseleave', 'buses', () => {
					instance.getCanvas().style.cursor = '';
				});
			});
		}

		init();

		return () => {
			destroyed = true;

			if (animationFrame !== undefined) {
				cancelAnimationFrame(animationFrame);
			}

			if (interval) {
				clearInterval(interval);
			}

			map?.remove();
		};
	});
</script>

<div class="map" bind:this={mapContainer}></div>

<style>
	.map {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100dvh;
	}
</style>
