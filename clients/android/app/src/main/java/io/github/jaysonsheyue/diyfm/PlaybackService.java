package io.github.jaysonsheyue.diyfm;

import android.content.Intent;
import android.app.PendingIntent;
import android.net.Uri;
import androidx.media3.common.*;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import org.json.*;
import java.util.*;

public final class PlaybackService extends MediaSessionService {
    static PlaybackService instance;
    static long revision=0;
    private ExoPlayer player;
    private MediaSession session;
    private String mode="once";
    private String playbackError="";
    @Override public void onCreate() {
        super.onCreate();instance=this;
        player=new ExoPlayer.Builder(this).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        player.addListener(new Player.Listener(){
            @Override public void onPlayerError(PlaybackException error){playbackError="playback";}
        });
        Intent open=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent activity=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        session=new MediaSession.Builder(this,player).setSessionActivity(activity).build();
    }
    @Override public MediaSession onGetSession(MediaSession.ControllerInfo info){return info.isTrusted() || info.getPackageName().equals(getPackageName())?session:null;}
    @Override public void onDestroy(){session.release();player.release();instance=null;super.onDestroy();}
    Set<String> activeKeys() {
        Set<String> keys=new HashSet<>();
        for(int i=0;i<player.getMediaItemCount();i++) {MediaItem item=player.getMediaItemAt(i);if(item.localConfiguration!=null) {String name=item.localConfiguration.uri.getLastPathSegment();if(name!=null)keys.add(name.replace(".wav",""));}}
        return keys;
    }
    JSONObject route(String command, JSONObject data, NativeFiles files) throws Exception {
        if(command.equals("player.state"))return state();
        long incoming=data.getLong("revision");
        if(incoming<revision)return state();
        revision=incoming;
        switch(command) {
            case "player.load": {
                JSONArray tracks=data.getJSONArray("tracks");if(tracks.length()<1 || tracks.length()>1000)throw new IllegalArgumentException("Queue limit");
                List<MediaItem> items=new ArrayList<>();int selected=-1;
                for(int i=0;i<tracks.length();i++) {
                    JSONObject track=tracks.getJSONObject(i);String id=track.getString("id"), key=NativeFiles.key(track.getString("key"));
                    if(!files.audio(key).isFile())throw new IllegalArgumentException("Audio missing");
                    if(id.equals(data.getString("selected")))selected=i;
                    items.add(new MediaItem.Builder().setMediaId(id).setUri(Uri.fromFile(files.audio(key))).setMediaMetadata(new MediaMetadata.Builder().setTitle(track.optString("title").substring(0,Math.min(240,track.optString("title").length()))).setArtist("DIYFM").build()).build());
                }
                if(selected<0)throw new IllegalArgumentException("Selected item missing");
                playbackError="";configure(data);player.setMediaItems(items,selected,0);player.prepare();player.play();break;
            }
            case "player.reconcile": {
                JSONArray ids=data.getJSONArray("ids");if(ids.length()>100000)throw new IllegalArgumentException("Library limit");
                Set<String> keep=new HashSet<>();for(int i=0;i<ids.length();i++)keep.add(ids.getString(i));
                MediaItem current=player.getCurrentMediaItem();
                if(current!=null && !keep.contains(current.mediaId)){player.pause();player.stop();player.clearMediaItems();}
                else for(int i=player.getMediaItemCount()-1;i>=0;i--)if(!keep.contains(player.getMediaItemAt(i).mediaId))player.removeMediaItem(i);
                break;
            }
            case "player.play": if(player.getPlaybackState()==Player.STATE_ENDED)player.seekTo(0);player.play();break;
            case "player.pause": player.pause();break;
            case "player.stop": player.pause();player.stop();player.clearMediaItems();playbackError="";break;
            case "player.configure":configure(data);break;
            case "player.seek":player.seekTo(Math.max(0,(long)(data.getDouble("time")*1000)));break;
            default:throw new IllegalArgumentException("Unknown player action");
        }
        return state();
    }
    private void configure(JSONObject data) throws Exception {
        mode=data.getString("mode");
        if(!Arrays.asList("once","single","channel").contains(mode))throw new IllegalArgumentException("Invalid mode");
        float rate=(float)data.getDouble("rate");if(!Float.isFinite(rate)||rate<.5f||rate>2f)throw new IllegalArgumentException("Invalid rate");
        player.setRepeatMode(mode.equals("single")?Player.REPEAT_MODE_ONE:mode.equals("channel")?Player.REPEAT_MODE_ALL:Player.REPEAT_MODE_OFF);
        player.setPlaybackSpeed(rate);
    }
    JSONObject state() throws Exception {
        MediaItem item=player.getCurrentMediaItem();long duration=player.getDuration();
        return new JSONObject().put("revision",revision).put("id",item==null?"":item.mediaId).put("title",item==null?"":String.valueOf(item.mediaMetadata.title))
            .put("paused",!player.getPlayWhenReady() || player.getPlaybackState()==Player.STATE_ENDED).put("ended",player.getPlaybackState()==Player.STATE_ENDED)
            .put("time",Math.max(0,player.getCurrentPosition())/1000.0).put("duration",duration==C.TIME_UNSET?0:Math.max(0,duration)/1000.0)
            .put("rate",player.getPlaybackParameters().speed).put("error",playbackError);
    }
}
