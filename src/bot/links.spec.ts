import { parseLink } from './links.js';

describe('parseLink', () => {
  it.each([
    ['https://www.instagram.com/reel/AbC_12-x/', 'instagram', 'ig:AbC_12-x'],
    ['https://www.tiktok.com/@user.name/video/7300000000000000000', 'tiktok', 'tt:7300000000000000000'],
    ['https://vm.tiktok.com/ZMabc123/', 'tiktok', 'tt:s:ZMabc123'],
    ['https://www.pinterest.com/pin/some-title--123456/', 'pinterest', 'pin:123456'],
    ['https://pin.it/4xYz', 'pinterest', 'pin:s:4xYz'],
    ['https://www.facebook.com/reel/1234567890', 'facebook', 'fb:1234567890'],
    ['https://m.facebook.com/watch/?v=987654321', 'facebook', 'fb:987654321'],
    ['https://www.facebook.com/page/videos/my-title/444555/', 'facebook', 'fb:444555'],
    ['https://fb.watch/abCD12-x/', 'facebook', 'fb:s:abCD12-x'],
    ['https://www.facebook.com/share/r/XyZ123/', 'facebook', 'fb:s:XyZ123'],
  ])('%s', (text, platform, cacheKey) => {
    expect(parseLink(`qarang: ${text}`)).toMatchObject({ platform, cacheKey });
  });

  it('boshqa havolalarni tanimaydi', () => {
    expect(parseLink('https://youtube.com/watch?v=1')).toBeNull();
    expect(parseLink('salom')).toBeNull();
  });
});
