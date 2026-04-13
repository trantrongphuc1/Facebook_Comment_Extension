function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = '';

	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

async function fetchImageAsDataUrl(url) {
	const normalized = `${url || ''}`.trim().replace(/[\])}>.,;!?]+$/g, '');
	if (!/^https?:\/\//i.test(normalized)) {
		throw new Error('URL ảnh không hợp lệ');
	}

	const response = await fetch(normalized, {
		method: 'GET',
		cache: 'no-store',
		referrerPolicy: 'no-referrer'
	});

	if (!response.ok) {
		throw new Error(`Không tải được ảnh: HTTP ${response.status}`);
	}

	const blob = await response.blob();
	if (!blob.type.startsWith('image/')) {
		throw new Error('URL không trả về dữ liệu ảnh');
	}

	const base64 = arrayBufferToBase64(await blob.arrayBuffer());
	return `data:${blob.type};base64,${base64}`;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request?.action !== 'fetchImageAsDataUrl') {
		return;
	}

	(async () => {
		try {
			const dataUrl = await fetchImageAsDataUrl(request.url || '');
			sendResponse({ ok: true, dataUrl });
		} catch (error) {
			sendResponse({ ok: false, message: error?.message || 'Không tải được ảnh' });
		}
	})();

	return true;
});