<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';

	let mapContainer: HTMLDivElement;

	onMount(() => {
		let map: import('maplibre-gl').Map | undefined;
		let disposed = false;

		import('maplibre-gl').then(({ Map: MapLibreMap, NavigationControl }) => {
			if (disposed) return;

			map = new MapLibreMap({
				container: mapContainer,
				style: 'https://tiles.openfreemap.org/styles/positron',
				center: [153.0251, -27.4698],
				zoom: 11
			});

			map.addControl(new NavigationControl(), 'top-right');
		});

		return () => {
			disposed = true;
			map?.remove();
		};
	});
</script>

<div class="map" bind:this={mapContainer}></div>

<style>
	.map {
		position: fixed;
		inset: 0;
	}
</style>
