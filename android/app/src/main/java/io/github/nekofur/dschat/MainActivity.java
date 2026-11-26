package io.github.nekofur.dschat;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.ProxyInfo;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

import java.util.concurrent.Executor;

/**
 * 主 Activity：在 Capacitor 默认行为之上，加一层「代理配置跟随系统变化」的处理。
 *
 * 背景：WebView 内部的 Chromium 会缓存网络代理。用户划掉 Clash 这类 VPN/代理 App 后，
 * 代理端口已经关闭，但 WebView 仍按旧配置走代理，所有请求都变成
 * ERR_PROXY_CONNECTION_FAILED，只有强停 App 才能恢复。
 *
 * 做法：监听默认网络的变化，每次变化都把当前的 HTTP 代理重新下发给 WebView
 * （没有代理就下发直连），强制 Chromium 刷新代理配置。
 */
public class MainActivity extends BridgeActivity {
    private ConnectivityManager connectivityManager;
    /** ProxyController 的回调线程，回调本身不用做额外事情 */
    private final Executor executor = Runnable::run;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 老版本 WebView 不支持代理覆盖，保持系统默认行为
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            return;
        }
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                applyProxy(network);
            }

            @Override
            public void onLinkPropertiesChanged(@NonNull Network network, @NonNull LinkProperties linkProperties) {
                applyProxy(network);
            }

            @Override
            public void onLost(@NonNull Network network) {
                // 原网络断开后按新的默认网络重新判定
                applyProxy(connectivityManager.getActiveNetwork());
            }
        };
        connectivityManager.registerDefaultNetworkCallback(callback);
        applyProxy(connectivityManager.getActiveNetwork());
    }

    /** 把指定网络当前的 HTTP 代理（可能为空 = 直连）下发给 WebView */
    private void applyProxy(Network network) {
        ProxyConfig.Builder builder = new ProxyConfig.Builder();
        LinkProperties properties = network == null ? null : connectivityManager.getLinkProperties(network);
        ProxyInfo httpProxy = properties == null ? null : properties.getHttpProxy();
        if (httpProxy != null && httpProxy.getHost() != null && !httpProxy.getHost().isEmpty()) {
            builder.addProxyRule(httpProxy.getHost() + ":" + httpProxy.getPort());
        }
        // 兜底直连：代理不可用时至少不会因为「没有规则」而卡住
        builder.addDirect();
        ProxyController.getInstance().setProxyOverride(builder.build(), executor, () -> {});
    }
}
