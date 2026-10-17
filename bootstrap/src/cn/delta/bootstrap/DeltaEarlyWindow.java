package cn.delta.bootstrap;

import net.minecraftforge.fml.earlydisplay.DisplayWindow;
import net.minecraftforge.fml.earlydisplay.RenderElement;
import net.minecraftforge.fml.loading.ImmediateWindowProvider;
import java.util.List;
import java.util.Optional;
import java.util.function.*;
import java.util.concurrent.*;

/** Forge 47.4.13 service-layer provider. Window ownership stays with Forge. */
public final class DeltaEarlyWindow implements ImmediateWindowProvider {
    private final DisplayWindow window=new DisplayWindow();
    @Override public String name(){return "deltaearlywindow";}
    @Override public Runnable initialize(String[] arguments){
        Runnable poll=window.initialize(arguments);
        try {
            ((Future<?>)field("initializationFuture")).get(30,TimeUnit.SECONDS);
            ((ScheduledExecutorService)field("renderScheduler")).submit(()->{
                try {
                    @SuppressWarnings("unchecked") var elements=(List<RenderElement>)field("elements");
                    var branded=new DeltaEarlyArt();
                    elements.clear();elements.add(branded.element());
                    System.out.println("[delta-bootstrap] branded early loading installed");
                }catch(Exception error){throw new IllegalStateException("Cannot install Delta loading artwork",error);}
            }).get(10,TimeUnit.SECONDS);
        }catch(Exception error){throw new IllegalStateException("Delta early window initialization failed",error);}
        return poll;
    }
    private Object field(String name)throws ReflectiveOperationException{
        var field=DisplayWindow.class.getDeclaredField(name);field.setAccessible(true);return field.get(window);
    }
    @Override public void updateFramebufferSize(IntConsumer width,IntConsumer height){window.updateFramebufferSize(width,height);}
    @Override public long setupMinecraftWindow(IntSupplier width,IntSupplier height,Supplier<String> title,LongSupplier monitor){return window.setupMinecraftWindow(width,height,title,monitor);}
    @Override public boolean positionWindow(Optional<Object> monitor,IntConsumer width,IntConsumer height,IntConsumer x,IntConsumer y){return window.positionWindow(monitor,width,height,x,y);}
    @Override public <T> Supplier<T> loadingOverlay(Supplier<?> minecraft,Supplier<?> reload,Consumer<Optional<Throwable>> complete,boolean fade){return window.loadingOverlay(minecraft,reload,complete,fade);}
    @Override public void updateModuleReads(ModuleLayer layer){window.updateModuleReads(layer);}
    @Override public void periodicTick(){window.periodicTick();}
    @Override public String getGLVersion(){return window.getGLVersion();}
}
