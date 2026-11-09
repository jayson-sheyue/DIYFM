package io.github.jaysonsheyue.diyfm;

import android.content.Context;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.ActivityTestRule;
import androidx.test.runner.AndroidJUnit4;
import org.junit.*;
import org.junit.runner.RunWith;
import org.json.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

/** Real Android storage/player integration. Synthetic tones, no model calls or private data. */
@RunWith(AndroidJUnit4.class)
public class ClientIntegrationTest {
    @Rule public ActivityTestRule<MainActivity> activity = new ActivityTestRule<>(MainActivity.class);
    interface Work {JSONObject run() throws Exception;}
    JSONObject main(Work work) throws Exception {
        AtomicReference<JSONObject> value=new AtomicReference<>();AtomicReference<Exception> error=new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->{try{value.set(work.run());}catch(Exception e){error.set(e);}});
        if(error.get()!=null)throw error.get();return value.get();
    }
    PlaybackService service() throws Exception {
        for(int i=0;i<100;i++){if(PlaybackService.instance!=null)return PlaybackService.instance;Thread.sleep(100);}throw new AssertionError("Media service did not start");
    }
    JSONObject state() throws Exception {return main(()->service().state());}
    byte[] wav(int frequency) {
        int samples=24000;ByteBuffer out=ByteBuffer.allocate(44+samples*2).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(out.capacity()-8).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short)1).putShort((short)1).putInt(24000).putInt(48000).putShort((short)2).putShort((short)16).put("data".getBytes(StandardCharsets.US_ASCII)).putInt(samples*2);
        for(int i=0;i<samples;i++)out.putShort((short)(7000*Math.sin(2*Math.PI*frequency*i/24000.0)+700*Math.sin(2*Math.PI*220*i/24000.0)));
        return out.array();
    }
    String save(NativeFiles files,int frequency) throws Exception {
        byte[] data=wav(frequency);StringBuilder key=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))key.append(String.format(Locale.ROOT,"%02x",b&255));
        JSONObject start=files.begin(new JSONObject().put("kind","media").put("id",key).put("size",data.length),null);
        if(!start.optBoolean("exists")){String ticket=start.getString("ticket");files.chunk(new JSONObject().put("ticket",ticket).put("offset",0).put("data",android.util.Base64.encodeToString(data,android.util.Base64.NO_WRAP)));files.commit(ticket);}
        return key.toString();
    }
    @Test public void nativeFilesValidateHashesOrderAndIncompleteWrites() throws Exception {
        NativeFiles files=new NativeFiles(activity.getActivity());String key=save(files,880);assertTrue(files.audio(key).isFile());
        byte[] bytes=wav(660);JSONObject begin=files.begin(new JSONObject().put("kind","media").put("id","a".repeat(64)).put("size",bytes.length),null);String ticket=begin.getString("ticket");
        try{files.chunk(new JSONObject().put("ticket",ticket).put("offset",1).put("data","AAAA"));fail("Out-of-order bytes accepted");}catch(Exception expected){}
        try{files.commit(ticket);fail("Incomplete transfer accepted");}catch(Exception expected){}
        files.chunk(new JSONObject().put("ticket",ticket).put("offset",0).put("data",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP)));
        try{files.commit(ticket);fail("Hash mismatch accepted");}catch(Exception expected){}
        files.abort(ticket);assertFalse(files.audio("a".repeat(64)).exists());assertTrue(files.audio(key).isFile());
    }
    @Test public void actualPlayerLoopsInBackgroundHonorsPauseAndRejectsOldIntents() throws Exception {
        NativeFiles files=new NativeFiles(activity.getActivity());String a=save(files,880),b=save(files,660);PlaybackService player=service();
        long revision=state().getLong("revision")+1;
        JSONArray tracks=new JSONArray().put(new JSONObject().put("id","qa_a").put("key",a).put("title","Synthetic A")).put(new JSONObject().put("id","qa_b").put("key",b).put("title","Synthetic B"));
        JSONObject load=new JSONObject().put("revision",revision).put("tracks",tracks).put("selected","qa_a").put("mode","channel").put("rate",1.0);
        main(()->player.route("player.load",load,files));
        boolean advanced=false;for(int i=0;i<80;i++){JSONObject s=state();if(s.optString("id").equals("qa_b")&&s.optDouble("time")>0){advanced=true;break;}Thread.sleep(100);}assertTrue("Real audio did not advance",advanced);
        main(()->{activity.getActivity().moveTaskToBack(true);return new JSONObject();});
        Thread.sleep(1400);assertFalse("Background service paused",state().getBoolean("paused"));assertTrue(state().getDouble("duration")>.9);
        java.lang.reflect.Field sessionField=PlaybackService.class.getDeclaredField("session");sessionField.setAccessible(true);
        androidx.media3.session.MediaSession session=(androidx.media3.session.MediaSession)sessionField.get(player);
        android.media.session.MediaController system=new android.media.session.MediaController(activity.getActivity(),session.getPlatformToken());
        assertNotNull("Notification cannot reopen the app",system.getSessionActivity());
        system.getTransportControls().pause();for(int i=0;i<30&&!state().getBoolean("paused");i++)Thread.sleep(100);assertTrue("Platform media pause failed",state().getBoolean("paused"));
        system.getTransportControls().seekTo(200);Thread.sleep(200);assertEquals(.2,state().getDouble("time"),.15);
        system.getTransportControls().play();for(int i=0;i<30&&state().getBoolean("paused");i++)Thread.sleep(100);assertFalse("Platform media resume failed",state().getBoolean("paused"));
        JSONObject pause=new JSONObject().put("revision",++revision);main(()->player.route("player.pause",pause,files));double position=state().getDouble("time");Thread.sleep(400);assertEquals(position,state().getDouble("time"),.1);
        JSONObject resume=new JSONObject().put("revision",++revision);main(()->player.route("player.play",resume,files));
        JSONObject config=new JSONObject().put("revision",revision).put("mode","single").put("rate",1.25);main(()->player.route("player.configure",config,files));String current=state().getString("id");Thread.sleep(1700);assertEquals(current,state().getString("id"));
        JSONObject stop=new JSONObject().put("revision",++revision);main(()->player.route("player.stop",stop,files));main(()->player.route("player.load",load,files));assertEquals("",state().getString("id"));assertTrue(state().getBoolean("paused"));
        main(()->{files.prune(player.activeKeys());return new JSONObject();});assertFalse(files.audio(a).exists());
    }
    @Test public void bundledFrontendStartsEnglishAndNativeBridgeWithoutNetwork() throws Exception {
        java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity.getActivity());
        String result="";
        for(int i=0;i<80;i++){
            CountDownLatch gate=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");
            main(()->{web.evaluateJavascript("JSON.stringify({language:document.documentElement.lang,ready:!!document.querySelector('#make')?.textContent.trim(),native:!!window.DIYFM_NATIVE,version:window.DIYFM_NATIVE?.info.version})",v->{value.set(v);gate.countDown();});return new JSONObject();});
            assertTrue(gate.await(3,TimeUnit.SECONDS));result=value.get();if(result.contains(BuildConfig.VERSION_NAME)&&result.contains("true"))break;Thread.sleep(100);
        }
        assertTrue(result,result.contains("en"));assertTrue(result,result.contains(BuildConfig.VERSION_NAME));assertTrue(result,result.contains("true"));
    }
}
