import { Routes } from '@angular/router';
import { HomeComponent } from './home/home.component';
import { ChatComponent } from './chat/chat.component';
import { VectorStoresComponent } from './vector-stores/vector-stores.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'chat', component: ChatComponent },
  { path: 'vector-stores', component: VectorStoresComponent },
  { path: '**', redirectTo: '' }
];
