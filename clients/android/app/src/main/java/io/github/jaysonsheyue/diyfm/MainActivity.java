package io.github.jaysonsheyue.diyfm;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.*;
import androidx.media3.session.*;
import androidx.webkit.*;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

public final class MainActivity extends Activity {
    static final String ORIGIN="https://appassets.androidplatform.net";
    private WebView web;
    private ValueCallback<Uri[]> importCallback;
    private Consumer<Uri> exportCallback;
    private NativeFiles files;
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private ListenableFuture<MediaController> controller;
    private boolean busy;
    private boolean keyboardOpen;
    private String language="en";
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        files=new NativeFiles(this);
        controller=new MediaController.Builder(this,new SessionToken(this,new ComponentName(this,PlaybackService.class))).buildAsync();
        web=new WebView(this);web.setBackgroundColor(Color.rgb(247,246,242));
        WebSettings settings=web.getSettings();settings.setUseWideViewPort(true);settings.setLoadWithOverviewMode(true);settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/assets/",new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient(){
            @Override public void onPageFinished(WebView view,String url){updateKeyboardLayout();}
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if(uri.getHost()!=null && uri.getHost().equals("appassets.androidplatform.net")) {
                    WebResourceResponse result=loader.shouldInterceptRequest(uri);
                    if(result==null)return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new java.io.ByteArrayInputStream(new byte[0]));
                    return result;
                }
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();if(uri.toString().startsWith(ORIGIN+"/assets/web/"))return false;
                if(request.isForMainFrame() && "https".equals(uri.getScheme()))openExternal(uri);
                return true;
            }
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
        });
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            new AlertDialog.Builder(this).setTitle("DIYFM").setMessage("Update Android System WebView before opening DIYFM.").setPositiveButton("Close",(d,w)->finish()).show();return;
        }
        WebViewCompat.addWebMessageListener(web,"diyfmNative",Collections.singleton(ORIGIN),(view,message,source,isMain,reply)->{
            if(!isMain || !ORIGIN.equals(source.toString()))return;
            try {
                JSONObject request=new JSONObject(message.getData());String id=request.getString("id"), command=request.getString("command");JSONObject data=request.optJSONObject("data");
                dispatch(command,data==null?new JSONObject():data,result->reply.postMessage(new JSONObject().put("id",id).put("result",result).toString()),()->{
                    try {reply.postMessage(new JSONObject().put("id",id).put("error",true).toString());}catch(Exception ignored){}
                });
            }catch(Exception ignored){}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(importCallback!=null)importCallback.onReceiveValue(null);importCallback=callback;
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip");
                try {startActivityForResult(intent,201);}catch(Exception e){callback.onReceiveValue(null);importCallback=null;}
                return true;
            }
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setNegativeButton(text("Cancel","キャンセル","取消"),(d,w)->result.cancel()).setPositiveButton(text("Confirm","確認","确认"),(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show();return true;
            }
            @Override public boolean onJsBeforeUnload(WebView view,String url,String message,JsResult result){return onJsConfirm(view,url,message,result);}
        });
        // Pad the container so the WebView's actual CSS viewport excludes bars, cutouts and IME.
        FrameLayout content=new FrameLayout(this);
        content.addView(web,new FrameLayout.LayoutParams(-1,-1));
        content.setOnApplyWindowInsetsListener(this::applyContentInsets);
        setContentView(content);content.requestApplyInsets();web.loadUrl(ORIGIN+"/assets/web/index.html");
    }
    WindowInsets applyContentInsets(View view,WindowInsets insets){
        if(Build.VERSION.SDK_INT>=30){
            android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            int keyboard=insets.getInsets(WindowInsets.Type.ime()).bottom;
            keyboardOpen=insets.isVisible(WindowInsets.Type.ime());
            view.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,keyboard));
        }else{
            view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
        }
        updateKeyboardLayout();return insets;
    }
    private void updateKeyboardLayout(){
        web.evaluateJavascript("document.documentElement?.classList.toggle('keyboard-open',"+keyboardOpen+")",null);
    }
    private String text(String en,String ja,String zh){return language.equals("ja")?ja:language.equals("zh-CN")?zh:en;}
    private void openExternal(Uri uri){try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}}
    interface Reply {void send(JSONObject object) throws Exception;}
    private void dispatch(String command,JSONObject data,Reply reply,Runnable fail) {
        Consumer<JSONObject> done=value->runOnUiThread(()->{try{reply.send(value);}catch(Exception ignored){fail.run();}});
        if(command.startsWith("player.") || command.equals("app.info") || command.equals("media.prune")) {
            controller.addListener(()->{
                try {
                    controller.get();PlaybackService player=PlaybackService.instance;if(player==null)throw new IllegalStateException();
                    if(command.equals("app.info"))done.accept(new JSONObject().put("platform","Android").put("version",BuildConfig.VERSION_NAME).put("generation",PlaybackService.revision).put("state",player.state()));
                    else if(command.equals("media.prune")){Set<String> keys=player.activeKeys();io.execute(()->{files.prune(keys);done.accept(new JSONObject());});}
                    else done.accept(player.route(command,data,files));
                }catch(Exception error){fail.run();}
            },this::runOnUiThread);return;
        }
        try {
            if(command.equals("app.busy")){busy=data.optBoolean("busy");language=data.optString("locale","en");done.accept(new JSONObject());return;}
            if(command.equals("app.updates")){openExternal(Uri.parse("https://github.com/jayson-sheyue/DIYFM/releases"));done.accept(new JSONObject());return;}
            if(command.equals("file.begin") && data.optString("kind").equals("export")) {
                if(exportCallback!=null)throw new IllegalStateException();
                String name=data.getString("name").replaceAll("[\\\\/\\p{Cntrl}]","_");if(name.length()>160)name=name.substring(0,150)+(name.endsWith(".mp3")?".mp3":".zip");
                if(!name.endsWith(".mp3") && !name.endsWith(".zip"))throw new IllegalArgumentException();
                exportCallback=uri->{if(uri==null) {try{done.accept(new JSONObject().put("cancelled",true));}catch(Exception e){fail.run();}} else io.execute(()->{try{done.accept(files.begin(data,uri));}catch(Exception e){fail.run();}});};
                startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(name.endsWith(".mp3")?"audio/mpeg":"application/zip").putExtra(Intent.EXTRA_TITLE,name),202);return;
            }
        }catch(Exception e){exportCallback=null;fail.run();return;}
        io.execute(()->{
            try {
                JSONObject result=switch(command){
                    case "file.begin" -> {if(!data.getString("kind").equals("media"))throw new IllegalArgumentException();yield files.begin(data,null);}
                    case "file.chunk" -> files.chunk(data);
                    case "file.commit" -> files.commit(data.getString("ticket"));
                    case "file.abort" -> files.abort(data.getString("ticket"));
                    default -> throw new IllegalArgumentException();
                };done.accept(result);
            }catch(Exception e){runOnUiThread(fail);}
        });
    }
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);
        if(request==201 && importCallback!=null){importCallback.onReceiveValue(result==RESULT_OK && data!=null?new Uri[]{data.getData()}:null);importCallback=null;}
        if(request==202 && exportCallback!=null){Consumer<Uri> callback=exportCallback;exportCallback=null;callback.accept(result==RESULT_OK && data!=null?data.getData():null);}
    }
    @Override public void onBackPressed(){moveTaskToBack(true);}
    @Override protected void onDestroy(){if(importCallback!=null)importCallback.onReceiveValue(null);if(exportCallback!=null)exportCallback.accept(null);MediaController.releaseFuture(controller);web.destroy();io.shutdown();super.onDestroy();}
}
